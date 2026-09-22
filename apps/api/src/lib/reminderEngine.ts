/**
 * 提醒规则引擎（纯函数，便于单测）。
 *
 * 输入批次快照与当前规则/本地日期，输出"应当存在的未终结事件集合"。
 * 数据库 reconcile 过程以同一口径用 SQL 实现；本模块用于单元测试与内存推演，
 * 保证业务规则（时区、阈值、提前天数档位）可在没有 PostgreSQL 的环境验证。
 */
import { addLocalDays, expiryTriggerDate, localDateToIso, type LocalDateParts } from "./time.js";

export type ReminderRuleSettings = {
  timezone: string;
  notifyAtTime: string; // HH:MM
  lowStockEnabled: boolean;
  expiryEnabled: boolean;
  expiryLeadDays: number[];
};

export type BatchSnapshot = {
  batchId: string;
  materialId: string;
  status: "ACTIVE" | "DEPLETED" | "ARCHIVED";
  remainingQuantity: string; // 十进制字符串
  lowStockThreshold: string | null;
  expiryAt: LocalDateParts | null;
};

export type DesiredEvent = {
  type: "LOW_STOCK" | "EXPIRY";
  dedupKey: string;
  batchId: string;
  materialId: string;
  leadDays: number | null;
  /** 计划触发的本地日期（HH:MM 由设置统一附加） */
  triggerLocalDate: LocalDateParts;
  expiryAt: LocalDateParts | null;
  thresholdQuantity: string | null;
  remainingQuantity: string | null;
};

function compareDecimalStrings(left: string, right: string): number {
  const parse = (value: string): bigint => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) throw new Error(`INVALID_DECIMAL:${value}`);
    return BigInt((match[1] ?? "0") + (match[2] ?? "").padEnd(6, "0").slice(0, 6));
  };
  const l = parse(left);
  const r = parse(right);
  return l === r ? 0 : l > r ? 1 : -1;
}

export function lowStockDedupKey(batchId: string): string {
  return `LOW_STOCK:${batchId}`;
}

export function expiryDedupKey(batchId: string, leadDays: number): string {
  return `EXPIRY:${batchId}:${leadDays}`;
}

/**
 * 计算单个批次在当前规则下应存在的全部未终结事件。
 *
 * 低余量（批次级口径，与批次列表筛选一致）：
 * - 批次 ACTIVE 且 0 < remaining <= material.lowStockThreshold
 * - 阈值为空或批次耗尽/归档则不产生事件
 * - 触发本地日 = 今天（跌破即应尽快通知）
 *
 * 临期（批次级口径）：
 * - 批次非 ARCHIVED、剩余 > 0、有有效期
 * - 对每个 leadDays 档位：triggerDate = expiryAt - leadDays
 * - 只要今天已经到达/越过触发日即应存在（未发送的继续等当日时刻，过期未发也保留）
 */
export function desiredEventsForBatch(
  batch: BatchSnapshot,
  settings: ReminderRuleSettings,
  today: LocalDateParts
): DesiredEvent[] {
  const events: DesiredEvent[] = [];
  const hasStock = compareDecimalStrings(batch.remainingQuantity, "0") > 0;

  if (
    settings.lowStockEnabled &&
    batch.status === "ACTIVE" &&
    hasStock &&
    batch.lowStockThreshold !== null &&
    compareDecimalStrings(batch.remainingQuantity, batch.lowStockThreshold) <= 0
  ) {
    events.push({
      type: "LOW_STOCK",
      dedupKey: lowStockDedupKey(batch.batchId),
      batchId: batch.batchId,
      materialId: batch.materialId,
      leadDays: null,
      triggerLocalDate: today,
      expiryAt: null,
      thresholdQuantity: batch.lowStockThreshold,
      remainingQuantity: batch.remainingQuantity
    });
  }

  if (settings.expiryEnabled && batch.status !== "ARCHIVED" && hasStock && batch.expiryAt) {
    for (const leadDays of settings.expiryLeadDays) {
      const triggerLocalDate = expiryTriggerDate(batch.expiryAt, leadDays);
      // 触发日在未来的档位本轮不产生（后续扫描到点自然产生）
      if (compareLocalDates(triggerLocalDate, today) > 0) continue;
      events.push({
        type: "EXPIRY",
        dedupKey: expiryDedupKey(batch.batchId, leadDays),
        batchId: batch.batchId,
        materialId: batch.materialId,
        leadDays,
        triggerLocalDate,
        expiryAt: batch.expiryAt,
        thresholdQuantity: null,
        remainingQuantity: batch.remainingQuantity
      });
    }
  }

  return events;
}

export function compareLocalDates(left: LocalDateParts, right: LocalDateParts): number {
  const l = localDateToIso(left);
  const r = localDateToIso(right);
  return l === r ? 0 : l > r ? 1 : -1;
}

export function desiredEvents(
  batches: BatchSnapshot[],
  settings: ReminderRuleSettings,
  today: LocalDateParts
): DesiredEvent[] {
  return batches.flatMap((batch) => desiredEventsForBatch(batch, settings, today));
}

/**
 * 将期望集合与现存未终结事件对齐，产出三类动作。
 * 仅 PENDING 事件允许 CANCEL/RESCHEDULE；SENT 事件永不重发：
 * - 期望中消失        -> PENDING 取消；SENT 标记 RESOLVED
 * - 期望中仍存在      -> PENDING 且触发日变化 -> 改期；否则不动；SENT 不动
 * - 期望中新增        -> 插入 PENDING
 *
 * @param existing 现存 PENDING/SENT 事件（含 triggerLocalDate 口径）
 */
export type StoredEvent = {
  dedupKey: string;
  status: "PENDING" | "SENT";
  triggerLocalDate: LocalDateParts;
  /** 已存事件快照（用于判断是否需要刷新余量/阈值/有效期）；缺省视为与目标一致 */
  remainingQuantity?: string | null;
  thresholdQuantity?: string | null;
  expiryAt?: LocalDateParts | null;
};

export type ReconcileAction =
  | { kind: "INSERT"; event: DesiredEvent }
  | { kind: "CANCEL"; dedupKey: string }
  | { kind: "RESOLVE"; dedupKey: string }
  | { kind: "RESCHEDULE"; dedupKey: string; event: DesiredEvent }
  | { kind: "REFRESH"; event: DesiredEvent };

export function reconcilePlan(existing: StoredEvent[], desired: DesiredEvent[]): ReconcileAction[] {
  const desiredByKey = new Map(desired.map((event) => [event.dedupKey, event]));
  const actions: ReconcileAction[] = [];

  for (const stored of existing) {
    const target = desiredByKey.get(stored.dedupKey);
    if (!target) {
      actions.push({ kind: stored.status === "PENDING" ? "CANCEL" : "RESOLVE", dedupKey: stored.dedupKey });
      continue;
    }
    if (stored.status === "PENDING") {
      // 只有临期事件会因有效期/提前档位变化而改期；
      // 低余量事件触发时刻恒为"跌破当日的通知时刻"，跨日扫描保留更早的计划时刻，避免漏报被逐日顺延。
      if (target.type === "EXPIRY" && compareLocalDates(stored.triggerLocalDate, target.triggerLocalDate) !== 0) {
        actions.push({ kind: "RESCHEDULE", dedupKey: stored.dedupKey, event: target });
      } else if (
        (stored.remainingQuantity ?? target.remainingQuantity) !== target.remainingQuantity ||
        (stored.thresholdQuantity ?? target.thresholdQuantity) !== target.thresholdQuantity ||
        (stored.expiryAt ?? target.expiryAt) !== target.expiryAt
      ) {
        actions.push({ kind: "REFRESH", event: target });
      }
    }
  }

  const existingKeys = new Set(existing.map((event) => event.dedupKey));
  for (const event of desired) {
    if (!existingKeys.has(event.dedupKey)) actions.push({ kind: "INSERT", event });
  }

  return actions;
}

/** 事件标题/正文，SQL 层与（未来的）其他投递渠道共用同一文案口径 */
export function renderLowStockMessage(batch: {
  materialName: string;
  batchCode: string | null;
  remainingQuantity: string;
  stockUnit: string;
  thresholdQuantity: string;
}): { title: string; body: string } {
  const code = batch.batchCode ? `（批次 ${batch.batchCode}）` : "";
  return {
    title: `低余量提醒：${batch.materialName}${code}`,
    body: `批次剩余 ${batch.remainingQuantity}${batch.stockUnit}，已达到或低于低余量阈值 ${batch.thresholdQuantity}${batch.stockUnit}，请及时补充。`
  };
}

export function renderExpiryMessage(batch: {
  materialName: string;
  batchCode: string | null;
  leadDays: number;
  expiryIsoDate: string;
  stockUnit: string;
  remainingQuantity: string;
}): { title: string; body: string } {
  const code = batch.batchCode ? `（批次 ${batch.batchCode}）` : "";
  const when = batch.leadDays === 0 ? "今日到期" : `距到期还有 ${batch.leadDays} 天`;
  return {
    title: `临期提醒：${batch.materialName}${code}`,
    body: `${when}，有效期至 ${batch.expiryIsoDate}；当前剩余 ${batch.remainingQuantity}${batch.stockUnit}，请优先安排使用。`
  };
}

export { addLocalDays };
