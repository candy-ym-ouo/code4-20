import type { Logger } from "pino";
import { pool, withTransaction, type DbClient } from "./db.js";
import { AppError } from "./errors.js";
import { writeAudit } from "./audit.js";
import { parseTimeOfTime, todayInTimeZone, zonedDateTimeToUtc, localDateToIso } from "./time.js";

export type ReminderScope =
  | { kind: "ALL" }
  | { kind: "MATERIAL"; materialId: string }
  | { kind: "BATCH"; batchId: string };

export type ReminderSettingsRow = {
  timezone: string;
  notifyAtTime: string;
  lowStockEnabled: boolean;
  expiryEnabled: boolean;
  expiryLeadDays: number[];
  version: number;
};

type SettingsRecord = {
  timezone: string;
  notify_at_time: string;
  low_stock_enabled: boolean;
  expiry_enabled: boolean;
  expiry_lead_days: number[];
  version: number;
};

function mapSettings(row: SettingsRecord): ReminderSettingsRow {
  return {
    timezone: row.timezone,
    notifyAtTime: row.notify_at_time,
    lowStockEnabled: row.low_stock_enabled,
    expiryEnabled: row.expiry_enabled,
    expiryLeadDays: row.expiry_lead_days,
    version: row.version
  };
}

async function lockSettings(client: DbClient): Promise<ReminderSettingsRow> {
  const result = await client.query<SettingsRecord>(
    "SELECT timezone, notify_at_time, low_stock_enabled, expiry_enabled, expiry_lead_days, version FROM reminder_settings WHERE id = 1 FOR UPDATE"
  );
  const row = result.rows[0];
  if (!row) throw new Error("REMINDER_SETTINGS_MISSING");
  return mapSettings(row);
}

export type ReconcileCounters = {
  inserted: number;
  rescheduled: number;
  refreshed: number;
  cancelled: number;
  resolved: number;
};

/**
 * "期望事件集合 vs 现存未终结事件"对齐 SQL。口径与 reminderEngine.ts 一致：
 *
 * - 低余量（批次级，与批次列表筛选一致）：ACTIVE 批次且 0 < remaining <= 材料阈值
 * - 临期（批次级）：非归档、有剩余、有有效期；每个提前天数档位各一个事件，
 *   触发日本地日 = expiry_at - lead_days，到达触发日即纳入期望集合
 *
 * 对齐规则：
 * - 新目标                         -> 插入 PENDING
 * - PENDING 且触发时刻漂移          -> 改期
 * - 目标消失的 PENDING             -> CANCELLED（规则/数据变更，未发项重算）
 * - 目标消失的 SENT                -> RESOLVED（已发绝不重发）
 * - 其余 PENDING/SENT              -> 不动（重复扫描幂等，杜绝重复通知）
 *
 * 范围通过参数 $9('ALL'/'MATERIAL'/'BATCH') + $3(uuid) 控制，SQL 本身无需随范围变化。
 */
export function buildReconcileSql(): { sql: string } {
  // 范围条件用 $9(scope kind) 显式分派，$3 在任何范围下都带 ::uuid 类型，
  // 避免 ALL 范围时参数未在语句中出现而被驱动判定为"无法推断类型"。
  const desiredScope = `AND CASE $9 WHEN 'BATCH' THEN b.id = $3::uuid WHEN 'MATERIAL' THEN b.material_id = $3::uuid ELSE true END`;
  const existingScope = `WHERE CASE $9 WHEN 'BATCH' THEN e.batch_id = $3::uuid WHEN 'MATERIAL' THEN e.material_id = $3::uuid ELSE true END`;

  const sql = `
    WITH desired AS (
      SELECT 'LOW_STOCK'::reminder_type AS type,
             ('LOW_STOCK:' || b.id) AS dedup_key,
             b.id AS batch_id, b.material_id,
             NULL::integer AS lead_days,
             $4::date AS trigger_date,
             NULL::date AS expiry_at,
             m.low_stock_threshold AS threshold_qty,
             b.remaining_quantity AS remaining_qty
        FROM batches b JOIN materials m ON m.id = b.material_id
       WHERE $5::boolean
         AND m.archived_at IS NULL
         AND b.status = 'ACTIVE' AND b.remaining_quantity > 0
         AND m.low_stock_threshold IS NOT NULL AND b.remaining_quantity <= m.low_stock_threshold
         ${desiredScope}
      UNION ALL
      SELECT 'EXPIRY'::reminder_type,
             ('EXPIRY:' || b.id || ':' || lead.lead_days),
             b.id, b.material_id,
             lead.lead_days,
             (b.expiry_at - lead.lead_days)::date,
             b.expiry_at,
             NULL::numeric, b.remaining_quantity
        FROM batches b JOIN materials m ON m.id = b.material_id
        CROSS JOIN unnest($6::integer[]) AS lead(lead_days)
       WHERE $7::boolean
         AND m.archived_at IS NULL
         AND b.status <> 'ARCHIVED' AND b.remaining_quantity > 0
         AND b.expiry_at IS NOT NULL
         AND (b.expiry_at - lead.lead_days) <= $4::date
         ${desiredScope}
    ),
    desired_named AS (
      SELECT d.*, m.name AS material_name, b.batch_code, b.stock_unit
        FROM desired d
        JOIN batches b ON b.id = d.batch_id
        JOIN materials m ON m.id = d.material_id
    ),
    existing AS (
      -- 只对齐未终结事件；CANCELLED/RESOLVED 是历史，不阻止同一幂等键的新事件
      SELECT e.* FROM reminder_events e ${existingScope}
        AND e.status IN ('PENDING', 'SENT')
    ),
    do_insert AS (
      INSERT INTO reminder_events
        (type, status, batch_id, material_id, dedup_key, lead_days,
         threshold_quantity, remaining_quantity, expiry_at, title, body,
         scheduled_at, rule_version)
      SELECT dn.type, 'PENDING', dn.batch_id, dn.material_id, dn.dedup_key, dn.lead_days,
             dn.threshold_qty, dn.remaining_qty, dn.expiry_at,
             CASE WHEN dn.type = 'LOW_STOCK'
               THEN '低余量提醒：' || dn.material_name || COALESCE('（批次 ' || dn.batch_code || '）', '')
               ELSE '临期提醒：' || dn.material_name || COALESCE('（批次 ' || dn.batch_code || '）', '')
             END,
             CASE WHEN dn.type = 'LOW_STOCK'
               THEN '批次剩余 ' || dn.remaining_qty::text || dn.stock_unit
                    || '，已达到或低于低余量阈值 ' || dn.threshold_qty::text || dn.stock_unit || '，请及时补充。'
               ELSE (CASE WHEN dn.lead_days = 0 THEN '今日到期'
                          ELSE '距到期还有 ' || dn.lead_days || ' 天' END)
                    || '，有效期至 ' || dn.expiry_at::text
                    || '；当前剩余 ' || dn.remaining_qty::text || dn.stock_unit || '，请优先安排使用。'
             END,
             timezone_trigger(dn.trigger_date, $1, $2),
             $8::integer
        FROM desired_named dn
       WHERE NOT EXISTS (SELECT 1 FROM existing e WHERE e.dedup_key = dn.dedup_key)
      RETURNING 1
    ),
    do_reschedule AS (
      UPDATE reminder_events e SET scheduled_at = timezone_trigger(d.trigger_date, $1, $2),
             lead_days = d.lead_days, expiry_at = d.expiry_at,
             remaining_quantity = d.remaining_qty, rule_version = $8
        FROM desired_named d
       WHERE e.dedup_key = d.dedup_key AND e.status = 'PENDING' AND e.type = 'EXPIRY'
         AND e.scheduled_at <> timezone_trigger(d.trigger_date, $1, $2)
      RETURNING 1
    ),
    do_refresh AS (
      -- 未发事件仍匹配目标时，刷新可变快照（余量/阈值/文案），不触碰发送时刻与状态。
      -- 与 do_reschedule 互斥：触发时刻漂移的临期事件已在改期分支一并刷新。
      UPDATE reminder_events e SET
             remaining_quantity = d.remaining_qty,
             threshold_quantity = d.threshold_qty,
             expiry_at = d.expiry_at,
             title = CASE WHEN d.type = 'LOW_STOCK'
               THEN '低余量提醒：' || d.material_name || COALESCE('（批次 ' || d.batch_code || '）', '')
               ELSE '临期提醒：' || d.material_name || COALESCE('（批次 ' || d.batch_code || '）', '')
             END,
             body = CASE WHEN d.type = 'LOW_STOCK'
               THEN '批次剩余 ' || d.remaining_qty::text || d.stock_unit
                    || '，已达到或低于低余量阈值 ' || d.threshold_qty::text || d.stock_unit || '，请及时补充。'
               ELSE (CASE WHEN d.lead_days = 0 THEN '今日到期'
                          ELSE '距到期还有 ' || d.lead_days || ' 天' END)
                    || '，有效期至 ' || d.expiry_at::text
                    || '；当前剩余 ' || d.remaining_qty::text || d.stock_unit || '，请优先安排使用。'
             END
        FROM desired_named d
       WHERE e.dedup_key = d.dedup_key AND e.status = 'PENDING'
         AND (e.type <> 'EXPIRY' OR e.scheduled_at = timezone_trigger(d.trigger_date, $1, $2))
         AND (e.remaining_quantity IS DISTINCT FROM d.remaining_qty
              OR e.threshold_quantity IS DISTINCT FROM d.threshold_qty
              OR e.expiry_at IS DISTINCT FROM d.expiry_at)
      RETURNING 1
    ),
    do_cancel AS (
      UPDATE reminder_events e SET status = 'CANCELLED', cancelled_at = now(),
             cancel_reason = '规则或数据变更后不再满足触发条件'
        FROM existing x
       WHERE e.id = x.id AND x.status = 'PENDING'
         AND NOT EXISTS (SELECT 1 FROM desired d WHERE d.dedup_key = x.dedup_key)
      RETURNING 1
    ),
    do_resolve AS (
      UPDATE reminder_events e SET status = 'RESOLVED', resolved_at = now()
        FROM existing x
       WHERE e.id = x.id AND x.status = 'SENT'
         AND NOT EXISTS (SELECT 1 FROM desired d WHERE d.dedup_key = x.dedup_key)
      RETURNING 1
    )
    SELECT
      (SELECT count(*) FROM do_insert)::int AS inserted,
      (SELECT count(*) FROM do_reschedule)::int AS rescheduled,
      (SELECT count(*) FROM do_refresh)::int AS refreshed,
      (SELECT count(*) FROM do_cancel)::int AS cancelled,
      (SELECT count(*) FROM do_resolve)::int AS resolved
  `;
  return { sql };
}

async function runReconcile(
  client: DbClient,
  settings: ReminderSettingsRow,
  scope: ReminderScope,
  now: Date
): Promise<ReconcileCounters> {
  const { sql } = buildReconcileSql();
  const todayIso = localDateToIso(todayInTimeZone(settings.timezone, now));
  // 校验时区下今天的通知时刻可正常换算（时区设置错误时尽早暴露）
  const { hour, minute } = parseTimeOfTime(settings.notifyAtTime);
  zonedDateTimeToUtc(todayInTimeZone(settings.timezone, now), hour, minute, settings.timezone);

  const scopeId =
    scope.kind === "MATERIAL" ? scope.materialId : scope.kind === "BATCH" ? scope.batchId : "00000000-0000-0000-0000-000000000000";
  const params: unknown[] = [
    settings.timezone,
    settings.notifyAtTime,
    scopeId,
    todayIso,
    settings.lowStockEnabled,
    settings.expiryLeadDays,
    settings.expiryEnabled,
    settings.version,
    scope.kind
  ];
  const result = await client.query<ReconcileCounters>(sql, params);
  return result.rows[0] ?? { inserted: 0, rescheduled: 0, refreshed: 0, cancelled: 0, resolved: 0 };
}

/**
 * 依据当前规则重算批次级提醒事件。
 * 事务级 advisory lock 串行化全局/范围重算，配合部分唯一索引兜底并发重复。
 */
export async function reconcileReminders(
  scope: ReminderScope = { kind: "ALL" },
  now: Date = new Date()
): Promise<ReconcileCounters> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('reminder_reconcile'))");
    const settings = await lockSettings(client);
    return runReconcile(client, settings, scope, now);
  });
}

/**
 * 投递到期的 PENDING 事件。
 *
 * 单事务内锁定并认领一批到期事件，调用 notifier；全部成功才置 SENT。
 * notifier 抛错则整体回滚保留下次重试 —— 配合行锁与 SKIP LOCKED，
 * 重复调度/多实例部署不会重复通知。
 */
export type ReminderNotification = {
  id: string;
  type: "LOW_STOCK" | "EXPIRY";
  batchId: string;
  materialId: string;
  title: string;
  body: string;
  scheduledAt: string;
};

export type ReminderNotifier = {
  send(events: ReminderNotification[]): Promise<void>;
};

export class LogReminderNotifier implements ReminderNotifier {
  constructor(private readonly logger?: Pick<Logger, "info">) {}
  async send(events: ReminderNotification[]): Promise<void> {
    for (const event of events) {
      this.logger?.info({ reminderEventId: event.id, type: event.type }, `[reminder] ${event.title}: ${event.body}`);
    }
  }
}

export async function deliverDueReminders(notifier: ReminderNotifier, batchSize = 100): Promise<number> {
  return withTransaction(async (client) => {
    const due = await client.query<{
      id: string;
      type: "LOW_STOCK" | "EXPIRY";
      batch_id: string;
      material_id: string;
      title: string;
      body: string;
      scheduled_at: Date;
    }>(
      `SELECT id, type, batch_id, material_id, title, body, scheduled_at
         FROM reminder_events
        WHERE status = 'PENDING' AND scheduled_at <= now()
        ORDER BY scheduled_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize]
    );
    if (!due.rowCount) return 0;

    const notifications: ReminderNotification[] = due.rows.map((row) => ({
      id: row.id,
      type: row.type,
      batchId: row.batch_id,
      materialId: row.material_id,
      title: row.title,
      body: row.body,
      scheduledAt: row.scheduled_at.toISOString()
    }));

    await notifier.send(notifications);

    await client.query(
      `UPDATE reminder_events SET status = 'SENT', sent_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'PENDING'`,
      [due.rows.map((row) => row.id)]
    );
    return notifications.length;
  });
}

export async function getReminderSettings(): Promise<ReminderSettingsRow> {
  const result = await pool.query<SettingsRecord>(
    "SELECT timezone, notify_at_time, low_stock_enabled, expiry_enabled, expiry_lead_days, version FROM reminder_settings WHERE id = 1"
  );
  const row = result.rows[0];
  if (!row) throw new Error("REMINDER_SETTINGS_MISSING");
  return mapSettings(row);
}

export async function updateReminderSettings(input: {
  timezone?: string;
  notifyAtTime?: string;
  lowStockEnabled?: boolean;
  expiryEnabled?: boolean;
  expiryLeadDays?: number[];
  expectedVersion?: number;
  audit?: {
    actorUserId: string;
    requestId?: string;
  };
}): Promise<ReminderSettingsRow> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('reminder_reconcile'))");
    const current = await lockSettings(client);
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new AppError(409, "VERSION_CONFLICT", "提醒规则已被其他操作修改，请刷新后重试");
    }
    const updated = await client.query<SettingsRecord>(
      `UPDATE reminder_settings SET
         timezone = coalesce($1, timezone),
         notify_at_time = coalesce($2, notify_at_time),
         low_stock_enabled = coalesce($3, low_stock_enabled),
         expiry_enabled = coalesce($4, expiry_enabled),
         expiry_lead_days = CASE WHEN $5::boolean THEN $6::integer[] ELSE expiry_lead_days END,
         version = version + 1
       WHERE id = 1
       RETURNING timezone, notify_at_time, low_stock_enabled, expiry_enabled, expiry_lead_days, version`,
      [
        input.timezone ?? null,
        input.notifyAtTime ?? null,
        input.lowStockEnabled ?? null,
        input.expiryEnabled ?? null,
        Array.isArray(input.expiryLeadDays),
        Array.isArray(input.expiryLeadDays) ? [...input.expiryLeadDays].sort((a, b) => b - a) : null
      ]
    );
    const row = updated.rows[0];
    if (!row) throw new Error("REMINDER_SETTINGS_MISSING");
    const settings = mapSettings(row);

    if (input.audit) {
      await writeAudit(client, {
        actorUserId: input.audit.actorUserId,
        action: "UPDATE",
        entityType: "REMINDER_SETTINGS",
        entityId: "00000000-0000-0000-0000-000000000001",
        beforeData: {
          timezone: current.timezone,
          notifyAtTime: current.notifyAtTime,
          lowStockEnabled: current.lowStockEnabled,
          expiryEnabled: current.expiryEnabled,
          expiryLeadDays: current.expiryLeadDays
        },
        afterData: settings,
        requestId: input.audit.requestId
      });
    }

    // 规则变更后于同一事务立即重算全部未发项；接口返回时新口径已生效。
    await runReconcile(client, settings, { kind: "ALL" }, new Date());
    return settings;
  });
}
