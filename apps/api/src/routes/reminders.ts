import type { FastifyInstance } from "fastify";
import { reminderSettingsPatchSchema } from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import { isValidTimezone } from "../lib/time.js";
import { getReminderSettings, reconcileReminders, type ReconcileStats } from "../lib/reminders.js";
import { scheduleReminderRefresh } from "../lib/reminderScheduler.js";

type Query = Record<string, string | undefined>;

const eventStatuses = ["PENDING", "SENT", "CANCELLED", "SUPERSEDED"];
const eventTypes = ["LOW_STOCK", "EXPIRING_SOON", "EXPIRED"];

export async function reminderRoutes(app: FastifyInstance): Promise<void> {
  app.get("/reminder-settings", async () => {
    const settings = await getReminderSettings();
    return { data: settings };
  });

  app.patch("/reminder-settings", async (request) => {
    const input = parseInput(reminderSettingsPatchSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const updated = await withTransaction(async (client) => {
      const before = await client.query(
        `SELECT id, timezone, low_stock_enabled AS "lowStockEnabled", expiry_enabled AS "expiryEnabled",
                expiry_warning_days AS "expiryWarningDays", notify_time AS "notifyTime",
                last_scan_local_date, last_scan_at, version
           FROM reminder_settings WHERE id = 1 FOR UPDATE`
      );
      const old = before.rows[0];
      if (!old) throw new AppError(500, "REMINDER_SETTINGS_MISSING", "提醒配置不存在");
      if (old.version !== input.version) throw new AppError(409, "VERSION_CONFLICT", "提醒配置已被修改，请刷新后重试");
      if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
        throw new AppError(422, "INVALID_TIMEZONE", "时区无效，请使用 IANA 时区名称，例如 Asia/Shanghai");
      }
      const result = await client.query(
        `UPDATE reminder_settings SET
            timezone = coalesce($1, timezone),
            low_stock_enabled = coalesce($2, low_stock_enabled),
            expiry_enabled = coalesce($3, expiry_enabled),
            expiry_warning_days = coalesce($4, expiry_warning_days),
            notify_time = coalesce($5, notify_time),
            -- 规则变更：强制下一轮重算（按新时区/规则重建未发事件）
            last_scan_local_date = NULL,
            version = version + 1
          WHERE id = 1
          RETURNING timezone AS "timezone", low_stock_enabled AS "lowStockEnabled",
                    expiry_enabled AS "expiryEnabled", expiry_warning_days AS "expiryWarningDays",
                    notify_time AS "notifyTime", last_scan_local_date::text AS "lastScanLocalDate",
                    last_scan_at AS "lastScanAt", version`,
        [
          input.timezone ?? null,
          input.lowStockEnabled ?? null,
          input.expiryEnabled ?? null,
          input.expiryWarningDays ?? null,
          input.notifyTime ?? null
        ]
      );
      await writeAudit(client, {
        actorUserId: user.id,
        action: "UPDATE",
        entityType: "REMINDER_SETTINGS",
        // 配置表是单行（id=1 smallint），审计 entity_id 为 uuid，故不绑定具体 ID。
        entityId: null,
        beforeData: old,
        afterData: result.rows[0],
        requestId: request.id
      });
      return result.rows[0];
    });

    // 规则变更立即重算未发项（异步执行，不阻塞配置接口返回）。
    scheduleReminderRefresh(0);
    return { data: updated };
  });

  app.get("/reminder-events", async (request) => {
    const query = request.query as Query;
    const { page, pageSize, offset } = parsePagination(query);
    const values: unknown[] = [];
    const conditions: string[] = [];

    if (query.status) {
      if (!eventStatuses.includes(query.status)) throw new AppError(422, "INVALID_EVENT_STATUS", "事件状态筛选值无效");
      values.push(query.status);
      conditions.push(`e.status = $${values.length}::reminder_event_status`);
    }
    if (query.type) {
      if (!eventTypes.includes(query.type)) throw new AppError(422, "INVALID_EVENT_TYPE", "事件类型筛选值无效");
      values.push(query.type);
      conditions.push(`e.type = $${values.length}::reminder_event_type`);
    }
    if (query.materialId) {
      values.push(query.materialId);
      conditions.push(`b.material_id = $${values.length}::uuid`);
    }
    if (query.batchId) {
      values.push(query.batchId);
      conditions.push(`e.batch_id = $${values.length}::uuid`);
    }
    if (query.archived !== "true") {
      conditions.push("e.status IN ('PENDING', 'SENT')");
    }
    const where = conditions.length ? conditions.join(" AND ") : "1 = 1";

    const total = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM reminder_events e WHERE " + where, values);
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT e.id, e.batch_id AS "batchId", b.batch_code AS "batchCode",
              b.material_id AS "materialId", m.name AS "materialName", m.code AS "materialCode",
              m.stock_unit AS "stockUnit", e.type, e.status, e.trigger_date::text AS "triggerDate",
              e.scheduled_for AS "scheduledFor", e.sent_at AS "sentAt",
              e.quantity_snapshot::text AS "quantitySnapshot",
              e.threshold_snapshot::text AS "thresholdSnapshot",
              e.expiry_snapshot::text AS "expirySnapshot", e.days_to_expiry AS "daysToExpiry",
              e.cancel_reason AS "cancelReason", e.created_at AS "createdAt"
         FROM reminder_events e
         JOIN batches b ON b.id = e.batch_id
         JOIN materials m ON m.id = b.material_id
        WHERE ${where}
        ORDER BY e.scheduled_for DESC, e.created_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get("/reminder-events/summary", async () => {
    const result = await pool.query<{ pending: number; sentToday: number; lowStock: number; expiring: number; expired: number }>(
      `SELECT
         count(*) FILTER (WHERE e.status = 'PENDING')::int AS pending,
         count(*) FILTER (WHERE e.status = 'SENT' AND e.sent_at >= date_trunc('day', now()))::int AS "sentToday",
         count(*) FILTER (WHERE e.status IN ('PENDING', 'SENT') AND e.type = 'LOW_STOCK')::int AS "lowStock",
         count(*) FILTER (WHERE e.status IN ('PENDING', 'SENT') AND e.type = 'EXPIRING_SOON')::int AS expiring,
         count(*) FILTER (WHERE e.status IN ('PENDING', 'SENT') AND e.type = 'EXPIRED')::int AS expired
        FROM reminder_events e`
    );
    return { data: result.rows[0] };
  });

  app.post("/reminders/reconcile", async () => {
    // 手动重算本身就是一次带水位的日扫描，无需再调度后台刷新。
    const stats: ReconcileStats = await reconcileReminders({ markScan: true });
    return { data: stats };
  });
}
