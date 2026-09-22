import { describe, expect, it } from "vitest";
import {
  compareLocalDates,
  desiredEventsForBatch,
  expiryDedupKey,
  lowStockDedupKey,
  reconcilePlan,
  renderExpiryMessage,
  renderLowStockMessage,
  type BatchSnapshot,
  type ReminderRuleSettings,
  type StoredEvent
} from "../src/lib/reminderEngine.js";
import { addLocalDays } from "../src/lib/time.js";

const settings: ReminderRuleSettings = {
  timezone: "Asia/Shanghai",
  notifyAtTime: "09:00",
  lowStockEnabled: true,
  expiryEnabled: true,
  expiryLeadDays: [30, 7, 3, 1]
};

const today = { year: 2026, month: 9, day: 22, weekday: 2 };

function batch(overrides: Partial<BatchSnapshot> = {}): BatchSnapshot {
  return {
    batchId: "b1",
    materialId: "m1",
    status: "ACTIVE",
    remainingQuantity: "100.000000",
    lowStockThreshold: "200.000000",
    expiryAt: null,
    ...overrides
  };
}

describe("low stock desired events (batch level)", () => {
  it("creates an event when active remaining is below or equal to the material threshold", () => {
    const events = desiredEventsForBatch(batch(), settings, today);
    expect(events.filter((e) => e.type === "LOW_STOCK")).toHaveLength(1);
    expect(events[0]?.dedupKey).toBe(lowStockDedupKey("b1"));
  });

  it("treats remaining == threshold as low stock but remaining == 0 as depleted (no event)", () => {
    expect(desiredEventsForBatch(batch({ remainingQuantity: "200.000000" }), settings, today)).toHaveLength(1);
    const depleted = desiredEventsForBatch(batch({ remainingQuantity: "0", status: "DEPLETED" }), settings, today);
    expect(depleted.filter((e) => e.type === "LOW_STOCK")).toHaveLength(0);
  });

  it("does not create an event above threshold, without a threshold, or for archived batches", () => {
    expect(desiredEventsForBatch(batch({ remainingQuantity: "201" }), settings, today)).toHaveLength(0);
    expect(desiredEventsForBatch(batch({ lowStockThreshold: null }), settings, today)).toHaveLength(0);
    expect(desiredEventsForBatch(batch({ status: "ARCHIVED", remainingQuantity: "0" }), settings, today)).toHaveLength(0);
  });

  it("is suppressed when the low stock rule is disabled", () => {
    const events = desiredEventsForBatch(batch(), { ...settings, lowStockEnabled: false }, today);
    expect(events).toHaveLength(0);
  });
});

describe("expiry desired events (batch level, timezone-day based)", () => {
  const expiry = { year: 2026, month: 10, day: 22, weekday: 4 };

  it("creates one event per due lead-day bucket, future buckets excluded", () => {
    // 今天 2026-09-22：30 天档恰好今天触发；7/3/1 档在未来
    const events = desiredEventsForBatch(batch({ remainingQuantity: "500", lowStockThreshold: null, expiryAt: expiry }), settings, today);
    expect(events).toHaveLength(1);
    expect(events[0]?.dedupKey).toBe(expiryDedupKey("b1", 30));
  });

  it("creates every bucket whose trigger day has been reached", () => {
    // 2026-10-21：30/7/3 已到，1 天档当天（10-21）也到
    const lateToday = addLocalDays(expiry, -1);
    const events = desiredEventsForBatch(batch({ remainingQuantity: "500", lowStockThreshold: null, expiryAt: expiry }), settings, lateToday);
    expect(events.map((e) => e.leadDays).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 3, 7, 30]);
  });

  it("keeps expired-but-unresolved events in the desired set until stock is gone/archived", () => {
    const yesterday = addLocalDays(expiry, 1);
    const events = desiredEventsForBatch(batch({ remainingQuantity: "10", lowStockThreshold: null, expiryAt: expiry }), settings, yesterday);
    expect(events).toHaveLength(4);
    // 批次耗尽 -> 全部消失
    const depleted = desiredEventsForBatch(
      batch({ remainingQuantity: "0", status: "DEPLETED", lowStockThreshold: null, expiryAt: expiry }),
      settings,
      yesterday
    );
    expect(depleted).toHaveLength(0);
  });

  it("does not create expiry events without an expiry date or when disabled", () => {
    expect(desiredEventsForBatch(batch({ lowStockThreshold: null }), settings, today)).toHaveLength(0);
    const events = desiredEventsForBatch(
      batch({ remainingQuantity: "500", lowStockThreshold: null, expiryAt: expiry }),
      { ...settings, expiryEnabled: false },
      today
    );
    expect(events).toHaveLength(0);
  });
});

describe("reconcile plan: rule changes only recompute unsent items", () => {
  const lowKey = lowStockDedupKey("b1");
  const expiry30 = expiryDedupKey("b1", 30);

  it("inserts new desired events and leaves existing ones untouched on repeated scans", () => {
    const desired = desiredEventsForBatch(batch(), settings, today);
    const first = reconcilePlan([], desired);
    expect(first.filter((a) => a.kind === "INSERT")).toHaveLength(1);
    // 第二次扫描：现存 PENDING 与目标一致 -> 无动作（重复扫描不重复通知）
    const existing: StoredEvent[] = desired.map((event) => ({
      dedupKey: event.dedupKey,
      status: "PENDING",
      triggerLocalDate: event.triggerLocalDate
    }));
    expect(reconcilePlan(existing, desired)).toHaveLength(0);
  });

  it("cancels pending but never re-notifies sent events that disappeared; resolves sent once gone", () => {
    // 阈值上调后批次恢复 in_stock：低余量目标消失
    const recovered = desiredEventsForBatch(batch({ remainingQuantity: "500" }), settings, today);
    const actions = reconcilePlan(
      [
        { dedupKey: lowKey, status: "PENDING", triggerLocalDate: today },
        { dedupKey: expiry30, status: "SENT", triggerLocalDate: today }
      ],
      recovered
    );
    expect(actions).toContainEqual({ kind: "CANCEL", dedupKey: lowKey });
    expect(actions).toContainEqual({ kind: "RESOLVE", dedupKey: expiry30 });
    // SENT 不会产生 INSERT，也不会再通知
    expect(actions.some((a) => a.kind === "INSERT" && a.event.dedupKey === expiry30)).toBe(false);
  });

  it("re-notifies only after the previous episode resolved and the batch drops again", () => {
    // 场景：已 SENT 低余量 -> 补货回升（RESOLVED）-> 再次跌破 -> 新事件
    const recovered = desiredEventsForBatch(batch({ remainingQuantity: "500" }), settings, today);
    const resolve = reconcilePlan([{ dedupKey: lowKey, status: "SENT", triggerLocalDate: today }], recovered);
    expect(resolve).toEqual([{ kind: "RESOLVE", dedupKey: lowKey }]);

    const droppedAgain = desiredEventsForBatch(batch({ remainingQuantity: "80" }), settings, today);
    const reinsert = reconcilePlan([], droppedAgain);
    expect(reinsert).toContainEqual(expect.objectContaining({ kind: "INSERT" }));
  });

  it("reschedules pending expiry events when the trigger day moves (expiry date/lead days changed)", () => {
    const expiry = { year: 2026, month: 10, day: 22, weekday: 4 };
    // 有效期从 10-22 提前到 10-20：30 天档触发日 09-22 -> 09-20（未发送，改期而不是重发）
    const newExpiry = { year: 2026, month: 10, day: 20, weekday: 2 };
    const before = desiredEventsForBatch(batch({ remainingQuantity: "500", lowStockThreshold: null, expiryAt: expiry }), settings, today);
    const after = desiredEventsForBatch(batch({ remainingQuantity: "500", lowStockThreshold: null, expiryAt: newExpiry }), settings, today);
    const existing: StoredEvent[] = before.map((event) => ({
      dedupKey: event.dedupKey,
      status: "PENDING",
      triggerLocalDate: event.triggerLocalDate
    }));
    const actions = reconcilePlan(existing, after);
    expect(actions).toEqual([
      { kind: "RESCHEDULE", dedupKey: expiry30, event: expect.objectContaining({ dedupKey: expiry30 }) }
    ]);

    // 有效期推后到 11-01：30 天档触发日 10-02 尚在未来 -> 未发送事件取消，不产生任何新通知
    const pushed = desiredEventsForBatch(
      batch({ remainingQuantity: "500", lowStockThreshold: null, expiryAt: { year: 2026, month: 11, day: 1, weekday: 7 } }),
      settings,
      today
    );
    const cancelActions = reconcilePlan(existing, pushed);
    expect(cancelActions).toEqual([{ kind: "CANCEL", dedupKey: expiry30 }]);
  });

  it("does not reschedule SENT events even when recomputed under new rules", () => {
    const expiry = { year: 2026, month: 10, day: 22, weekday: 4 };
    const desired = desiredEventsForBatch(batch({ remainingQuantity: "500", lowStockThreshold: null, expiryAt: expiry }), settings, today);
    const actions = reconcilePlan(
      [{ dedupKey: expiry30, status: "SENT", triggerLocalDate: addLocalDays(today, -2) }],
      desired
    );
    expect(actions).toHaveLength(0);
    expect(compareLocalDates(addLocalDays(today, 1), today)).toBe(1);
  });
});

describe("message rendering", () => {
  it("renders Chinese low stock and expiry copy with quantities and units", () => {
    const low = renderLowStockMessage({
      materialName: "靛蓝染料",
      batchCode: "B-01",
      remainingQuantity: "120.000000",
      stockUnit: "g",
      thresholdQuantity: "200.000000"
    });
    expect(low.title).toContain("低余量提醒");
    expect(low.body).toContain("120.000000g");
    expect(low.body).toContain("200.000000g");

    const expiry = renderExpiryMessage({
      materialName: "蜂蜡",
      batchCode: null,
      leadDays: 0,
      expiryIsoDate: "2026-10-22",
      stockUnit: "g",
      remainingQuantity: "300.000000"
    });
    expect(expiry.body).toContain("今日到期");
  });
});
