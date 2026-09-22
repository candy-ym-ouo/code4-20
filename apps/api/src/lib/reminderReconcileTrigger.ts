import type { FastifyBaseLogger } from "fastify";
import { reconcileReminders, type ReminderScope } from "./reminders.js";

/**
 * 数据/规则变更后对"未发项"做范围重算。
 *
 * 重算在事务提交之后异步触发，避免把 HTTP 请求耗时绑在扫描上；
 * 短延迟去抖合并同批次的连续变更（一次入库/消耗可能同时影响阈值与有效期视图）。
 * 即使异步重算失败，周期性扫描也会兜底对齐 —— 这里只是让提醒更快收敛。
 */

const timers = new Map<string, NodeJS.Timeout>();
const DEFAULT_DELAY_MS = 2_000;
let logger: Pick<FastifyBaseLogger, "error"> | null = null;

export function initReminderReconciler(log: Pick<FastifyBaseLogger, "error">): void {
  logger = log;
}

function scopeKey(scope: ReminderScope): string {
  if (scope.kind === "ALL") return "ALL";
  return `${scope.kind}:${scope.kind === "MATERIAL" ? scope.materialId : scope.batchId}`;
}

export function scheduleReminderReconcile(scope: ReminderScope, delayMs: number = DEFAULT_DELAY_MS): void {
  const key = scopeKey(scope);
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(key);
    reconcileReminders(scope).catch((error) => {
      logger?.error({ err: error, scope }, "post-commit reminder reconcile failed");
    });
  }, delayMs);
  timer.unref?.();
  timers.set(key, timer);
}
