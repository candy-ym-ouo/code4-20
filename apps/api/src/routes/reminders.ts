import type { FastifyInstance } from "fastify";
import { reminderSettingsUpdateSchema } from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import {
  reconcileReminders,
  getReminderSettings,
  updateReminderSettings
} from "../lib/reminders.js";

type Query = Record<string, string | undefined>;

function serializeSettings(row: Awaited<ReturnType<typeof getReminderSettings>>) {
  return {
    timezone: row.timezone,
    notifyAtTime: row.notifyAtTime,
    lowStockEnabled: row.lowStockEnabled,
    expiryEnabled: row.expiryEnabled,
    expiryLeadDays: row.expiryLeadDays,
    version: row.version
  };
}

export async function reminderRoutes(app: FastifyInstance): Promise<void> {
  app.get("/reminders/settings", async () => {
    const settings = await getReminderSettings();
    return { data: serializeSettings(settings) };
  });

  app.get("/reminders/events/summary", async () => {
    const result = await pool.query<{
      pending_count: string;
      unread_count: string;
      low_stock_count: string;
      expiry_count: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'PENDING')::text AS pending_count,
         count(*) FILTER (WHERE sent_at IS NOT NULL AND read_at IS NULL AND status = 'SENT')::text AS unread_count,
         count(*) FILTER (WHERE type = 'LOW_STOCK' AND status IN ('PENDING','SENT'))::text AS low_stock_count,
         count(*) FILTER (WHERE type = 'EXPIRY' AND status IN ('PENDING','SENT'))::text AS expiry_count
        FROM reminder_events`
    );
    const row = result.rows[0];
    return {
      data: {
        pendingCount: Number(row?.pending_count ?? 0),
        unreadCount: Number(row?.unread_count ?? 0),
        activeLowStockCount: Number(row?.low_stock_count ?? 0),
        activeExpiryCount: Number(row?.expiry_count ?? 0)
      }
    };
  });

  app.put("/reminders/settings", async (request) => {
    const input = parseInput(reminderSettingsUpdateSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const settings = await updateReminderSettings({
      timezone: input.timezone,
      notifyAtTime: input.notifyAtTime,
      lowStockEnabled: input.lowStockEnabled,
      expiryEnabled: input.expiryEnabled,
      expiryLeadDays: input.expiryLeadDays,
      audit: { actorUserId: user.id, requestId: request.id }
    });
    return { data: serializeSettings(settings) };
  });

  app.get<{ Querystring: Query }>("/reminders/events", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions: string[] = [];

    if (request.query.type && !["LOW_STOCK", "EXPIRY"].includes(request.query.type)) {
      throw new AppError(422, "INVALID_REMINDER_TYPE", "提醒类型筛选值无效");
    }
    if (request.query.status && !["PENDING", "SENT", "RESOLVED", "CANCELLED"].includes(request.query.status)) {
      throw new AppError(422, "INVALID_REMINDER_STATUS", "提醒状态筛选值无效");
    }
    if (request.query.type) {
      values.push(request.query.type);
      conditions.push(`e.type = $${values.length}::reminder_type`);
    }
    if (request.query.status) {
      values.push(request.query.status);
      conditions.push(`e.status = $${values.length}::reminder_event_status`);
    }
    if (request.query.unread === "true") conditions.push("e.sent_at IS NOT NULL AND e.read_at IS NULL");
    if (request.query.batchId) {
      values.push(request.query.batchId);
      conditions.push(`e.batch_id = $${values.length}::uuid`);
    }
    if (request.query.materialId) {
      values.push(request.query.materialId);
      conditions.push(`e.material_id = $${values.length}::uuid`);
    }
    if (request.query.active === "true") {
      conditions.push("e.status IN ('PENDING', 'SENT')");
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reminder_events e ${where}`,
      values
    );
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT e.id, e.type, e.status, e.batch_id AS "batchId", e.material_id AS "materialId",
              m.name AS "materialName", b.batch_code AS "batchCode", e.lead_days AS "leadDays",
              e.threshold_quantity::text AS "thresholdQuantity",
              e.remaining_quantity::text AS "remainingQuantity",
              e.expiry_at AS "expiryAt", e.title, e.body,
              e.scheduled_at AS "scheduledAt", e.sent_at AS "sentAt", e.read_at AS "readAt",
              e.resolved_at AS "resolvedAt", e.cancelled_at AS "cancelledAt",
              e.cancel_reason AS "cancelReason", e.rule_version AS "ruleVersion",
              e.created_at AS "createdAt"
         FROM reminder_events e
         JOIN materials m ON m.id = e.material_id
         LEFT JOIN batches b ON b.id = e.batch_id
         ${where}
        ORDER BY CASE e.status WHEN 'PENDING' THEN 0 WHEN 'SENT' THEN 1 ELSE 2 END,
                 e.scheduled_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.post<{ Params: { id: string } }>("/reminders/events/:id/read", async (request) => {
    const result = await pool.query(
      `UPDATE reminder_events SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND sent_at IS NOT NULL
        RETURNING id, read_at AS "readAt"`,
      [request.params.id]
    );
    if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "提醒事件不存在或尚未发送");
    return { data: result.rows[0] };
  });

  app.post("/reminders/reconcile", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    const body = (request.body ?? {}) as { scope?: string; materialId?: string; batchId?: string };
    let scope: Parameters<typeof reconcileReminders>[0] = { kind: "ALL" };
    if (body.scope === "MATERIAL") {
      if (!body.materialId) throw new AppError(422, "MISSING_MATERIAL_ID", "按材料重算需要 materialId");
      scope = { kind: "MATERIAL", materialId: body.materialId };
    } else if (body.scope === "BATCH") {
      if (!body.batchId) throw new AppError(422, "MISSING_BATCH_ID", "按批次重算需要 batchId");
      scope = { kind: "BATCH", batchId: body.batchId };
    } else if (body.scope !== undefined && body.scope !== "ALL") {
      throw new AppError(422, "INVALID_SCOPE", "重算范围必须是 ALL、MATERIAL 或 BATCH");
    }
    const counters = await reconcileReminders(scope);
    await writeAudit(pool, {
      actorUserId: user.id,
      action: "RECONCILE",
      entityType: "REMINDER_EVENT",
      afterData: { scope, ...counters },
      requestId: request.id
    });
    return { data: counters };
  });
}
