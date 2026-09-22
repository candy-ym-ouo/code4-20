import { pool, withTransaction, type DbClient } from "./db.js";
import { isValidTimezone, localDateString, zonedDateTimeUtc } from "./time.js";

// 事务级咨询锁：同一时刻只允许一个重算（调度器 / API 触发 / 手工触发互斥）。
const RECONCILE_LOCK_KEY = "handcraft_reminder_reconcile";

export type ReminderSettings = {
  timezone: string;
  lowStockEnabled: boolean;
  expiryEnabled: boolean;
  expiryWarningDays: number;
  notifyTime: string;
  lastScanLocalDate: string | null;
  lastScanAt: Date | null;
  version: number;
};

export type ReconcileStats = {
  inserted: number;
  cancelled: number;
  superseded: number;
  delivered: number;
};

type Executor = Pick<DbClient, "query">;

const settingsSelect = `
  SELECT timezone AS "timezone", low_stock_enabled AS "lowStockEnabled",
         expiry_enabled AS "expiryEnabled", expiry_warning_days AS "expiryWarningDays",
         notify_time AS "notifyTime", last_scan_local_date::text AS "lastScanLocalDate",
         last_scan_at AS "lastScanAt", version
    FROM reminder_settings WHERE id = 1`;

export async function getReminderSettings(executor: Executor = pool): Promise<ReminderSettings> {
  const result = await executor.query<ReminderSettings>(settingsSelect);
  const row = result.rows[0];
  if (!row) throw new Error("REMINDER_SETTINGS_MISSING");
  return row;
}

/**
 * 依据当前规则与批次状态重算未发（PENDING）事件。
 *
 * 幂等保证：
 *  - 期望存在但未排程的事件按指纹插入（ON CONFLICT DO NOTHING + 部分唯一索引）；
 *  - 规则/数据变化后不再成立的 PENDING 事件标记 CANCELLED；
 *  - LOW_STOCK 已发事件在本轮低余量 episode 结束（补货/耗尽/阈值失效）后标记 SUPERSEDED，
 *    下次再次跌破阈值时可作为新一轮重新通知；
 *  - 临期/过期事件指纹为有效期日期，同一有效期只通知一次，改期才会产生新一轮。
 */
export async function reconcileReminders(options: { markScan?: boolean; now?: Date } = {}): Promise<ReconcileStats> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [RECONCILE_LOCK_KEY]);

    const settings = await getReminderSettings(client);
    if (!isValidTimezone(settings.timezone)) {
      throw new Error(`INVALID_TIMEZONE:${settings.timezone}`);
    }
    const now = options.now ?? new Date();
    const today = localDateString(settings.timezone, now);

    // 校验此刻排程时间合法（DST 等异常时区配置会直接报错，不静默产生错误时刻）。
    zonedDateTimeUtc(
      (() => {
        const [y, m, d] = today.split("-").map(Number) as [number, number, number];
        return { year: y, month: m, day: d };
      })(),
      settings.timezone,
      settings.notifyTime
    );

    const stats: ReconcileStats = { inserted: 0, cancelled: 0, superseded: 0, delivered: 0 };

    // 1. 低余量
    if (settings.lowStockEnabled) {
      // 1a. 不再成立的未发低余量事件 → CANCELLED
      stats.cancelled += (
        await client.query(
          `UPDATE reminder_events e
              SET status = 'CANCELLED', cancel_reason = 'NO_LONGER_LOW_STOCK'
            WHERE e.status = 'PENDING' AND e.type = 'LOW_STOCK'
              AND NOT EXISTS (
                SELECT 1
                  FROM batches b
                  JOIN materials m ON m.id = b.material_id
                 WHERE b.id = e.batch_id
                   AND b.status = 'ACTIVE' AND b.remaining_quantity > 0
                   AND m.archived_at IS NULL AND m.low_stock_threshold IS NOT NULL
                   AND b.remaining_quantity <= m.low_stock_threshold
              )`
        )
      ).rowCount ?? 0;

      // 1b. 已发事件：本轮 episode 已结束（补货/耗尽/归档/阈值变更）→ SUPERSEDED
      stats.superseded += (
        await client.query(
          `UPDATE reminder_events e
              SET status = 'SUPERSEDED', cancel_reason = 'EPISODE_ENDED'
            WHERE e.status = 'SENT' AND e.type = 'LOW_STOCK'
              AND NOT EXISTS (
                SELECT 1
                  FROM batches b
                  JOIN materials m ON m.id = b.material_id
                 WHERE b.id = e.batch_id
                   AND b.status = 'ACTIVE' AND b.remaining_quantity > 0
                   AND m.archived_at IS NULL AND m.low_stock_threshold IS NOT NULL
                   AND b.remaining_quantity <= m.low_stock_threshold
                   AND e.fingerprint = rtrim(rtrim(m.low_stock_threshold::text, '0'), '.')
              )`
        )
      ).rowCount ?? 0;

      // 1c. 新跌破阈值的批次 → PENDING（已存在同阈值活动事件的不重复生成）
      stats.inserted += (
        await client.query(
          `INSERT INTO reminder_events
              (batch_id, type, fingerprint, trigger_date, scheduled_for, quantity_snapshot, threshold_snapshot)
           SELECT b.id, 'LOW_STOCK', fp.text, $2::date,
                  (($2::date + $3::time) AT TIME ZONE $1),
                  b.remaining_quantity, m.low_stock_threshold
             FROM batches b
             JOIN materials m ON m.id = b.material_id
             CROSS JOIN LATERAL (SELECT rtrim(rtrim(m.low_stock_threshold::text, '0'), '.') AS text) fp
            WHERE b.status = 'ACTIVE' AND b.remaining_quantity > 0
              AND m.archived_at IS NULL AND m.low_stock_threshold IS NOT NULL
              AND b.remaining_quantity <= m.low_stock_threshold
              AND NOT EXISTS (
                SELECT 1 FROM reminder_events x
                 WHERE x.batch_id = b.id AND x.type = 'LOW_STOCK' AND x.fingerprint = fp.text
                   AND x.status IN ('PENDING', 'SENT')
              )
           ON CONFLICT DO NOTHING`,
          [settings.timezone, today, settings.notifyTime]
        )
      ).rowCount ?? 0;
    } else {
      stats.cancelled += (
        await client.query(
          `UPDATE reminder_events SET status = 'CANCELLED', cancel_reason = 'DISABLED'
            WHERE status = 'PENDING' AND type = 'LOW_STOCK'`
        )
      ).rowCount ?? 0;
    }

    // 2. 临期 / 过期
    if (settings.expiryEnabled) {
      // 2a. 排程依据消失或改期的未发事件 → CANCELLED（已发的不撤回、不重发）
      stats.cancelled += (
        await client.query(
          `UPDATE reminder_events e
              SET status = 'CANCELLED', cancel_reason = 'RULE_OR_EXPIRY_CHANGED'
            WHERE e.status = 'PENDING' AND e.type IN ('EXPIRING_SOON', 'EXPIRED')
              AND NOT EXISTS (
                SELECT 1
                  FROM batches b
                  JOIN materials m ON m.id = b.material_id
                  CROSS JOIN LATERAL (
                    SELECT coalesce(m.expiry_warning_days, $2::int) AS warn_days
                  ) w
                 WHERE b.id = e.batch_id
                   AND b.status = 'ACTIVE' AND b.remaining_quantity > 0
                   AND m.archived_at IS NULL AND b.expiry_at IS NOT NULL
                   AND e.fingerprint = b.expiry_at::text
                   AND e.trigger_date = CASE e.type
                         WHEN 'EXPIRING_SOON' THEN b.expiry_at - w.warn_days
                         ELSE b.expiry_at END
                   AND (
                     e.type = 'EXPIRED'
                     OR (b.expiry_at - $3::date) BETWEEN 1 AND w.warn_days
                   )
              )`,
          [settings.timezone, settings.expiryWarningDays, today]
        )
      ).rowCount ?? 0;

      // 2b. 临期（窗口内、尚未生成活动事件的批次）
      stats.inserted += (
        await client.query(
          `INSERT INTO reminder_events
              (batch_id, type, fingerprint, trigger_date, scheduled_for, expiry_snapshot, days_to_expiry)
           SELECT b.id, 'EXPIRING_SOON', b.expiry_at::text,
                  b.expiry_at - w.warn_days,
                  (((b.expiry_at - w.warn_days) + $3::time) AT TIME ZONE $1),
                  b.expiry_at, w.warn_days
             FROM batches b
             JOIN materials m ON m.id = b.material_id
             CROSS JOIN LATERAL (
               SELECT coalesce(m.expiry_warning_days, $2::int) AS warn_days
             ) w
            WHERE b.status = 'ACTIVE' AND b.remaining_quantity > 0
              AND m.archived_at IS NULL AND b.expiry_at IS NOT NULL
              AND (b.expiry_at - $4::date) BETWEEN 1 AND w.warn_days
              AND NOT EXISTS (
                SELECT 1 FROM reminder_events x
                 WHERE x.batch_id = b.id AND x.type = 'EXPIRING_SOON' AND x.fingerprint = b.expiry_at::text
                   AND x.status IN ('PENDING', 'SENT')
              )
           ON CONFLICT DO NOTHING`,
          [settings.timezone, settings.expiryWarningDays, settings.notifyTime, today]
        )
      ).rowCount ?? 0;

      // 2c. 已过期（今天及之前到期、仍有库存的活动批次；历史批次只补一次）
      stats.inserted += (
        await client.query(
          `INSERT INTO reminder_events
              (batch_id, type, fingerprint, trigger_date, scheduled_for, expiry_snapshot, days_to_expiry)
           SELECT b.id, 'EXPIRED', b.expiry_at::text,
                  b.expiry_at,
                  ((b.expiry_at + $3::time) AT TIME ZONE $1),
                  b.expiry_at, 0
             FROM batches b
             JOIN materials m ON m.id = b.material_id
            WHERE b.status = 'ACTIVE' AND b.remaining_quantity > 0
              AND m.archived_at IS NULL AND b.expiry_at IS NOT NULL
              AND b.expiry_at <= $4::date
              AND NOT EXISTS (
                SELECT 1 FROM reminder_events x
                 WHERE x.batch_id = b.id AND x.type = 'EXPIRED' AND x.fingerprint = b.expiry_at::text
                   AND x.status IN ('PENDING', 'SENT')
              )
           ON CONFLICT DO NOTHING`,
          [settings.timezone, settings.expiryWarningDays, settings.notifyTime, today]
        )
      ).rowCount ?? 0;
    } else {
      stats.cancelled += (
        await client.query(
          `UPDATE reminder_events SET status = 'CANCELLED', cancel_reason = 'DISABLED'
            WHERE status = 'PENDING' AND type IN ('EXPIRING_SOON', 'EXPIRED')`
        )
      ).rowCount ?? 0;
    }

    // 3. 到点投递（投递 = 进入 SENT；唯一索引保证不会重复投递同一事件）
    stats.delivered += await deliverDueEvents(client);

    // 4. 日扫描水位
    if (options.markScan) {
      await client.query(
        "UPDATE reminder_settings SET last_scan_local_date = $1::date, last_scan_at = now() WHERE id = 1",
        [today]
      );
    }

    return stats;
  });
}

async function deliverDueEvents(client: Executor, now: Date = new Date()): Promise<number> {
  const result = await client.query(
    `UPDATE reminder_events SET status = 'SENT', sent_at = now()
      WHERE id IN (
        SELECT id FROM reminder_events
         WHERE status = 'PENDING' AND scheduled_for <= $1
         ORDER BY scheduled_for
         FOR UPDATE SKIP LOCKED
         LIMIT 500
      )`,
    [now]
  );
  return result.rowCount ?? 0;
}

/**
 * 日扫描：同一操作员时区内每天只重算一次；
 * 到点事件的投递每次 tick 都执行（保证本地 notify_time 准时发送）。
 */
export async function runReminderScan(now: Date = new Date()): Promise<ReconcileStats> {
  const settings = await getReminderSettings();
  const today = localDateString(settings.timezone, now);
  if (settings.lastScanLocalDate === today) {
    // 今天已重算过：只投递到点事件，不重复生成/通知。
    const delivered = await withTransaction((client) => deliverDueEvents(client, now));
    return { inserted: 0, cancelled: 0, superseded: 0, delivered };
  }
  return reconcileReminders({ markScan: true, now });
}
