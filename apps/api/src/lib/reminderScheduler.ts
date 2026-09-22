import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { reconcileReminders, deliverDueReminders, LogReminderNotifier, type ReminderNotifier } from "./reminders.js";

/**
 * 提醒扫描调度器。
 *
 * 每个 tick 做两件事：
 * 1. reconcile：依据当前时区/规则把"批次现状"对齐为应存在的批次级事件
 *    （临期事件的触发日按本地日历滚动到点，因此周期扫描必须覆盖跨日）
 * 2. deliver：投递已到 scheduled_at 的 PENDING 事件
 *
 * 并发与重复通知防护全部在数据库层：
 * - reconcile 使用事务级 advisory lock，多实例/重叠 tick 串行化
 * - deliver 使用 FOR UPDATE SKIP LOCKED 认领，唯一索引兜底
 * running 标志只防止单进程内定时器与手动触发重叠。
 */
export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly notifier: ReminderNotifier;

  constructor(
    private readonly logger: FastifyBaseLogger,
    notifier?: ReminderNotifier,
    private readonly intervalMs: number = config.REMINDER_SCAN_INTERVAL_MS
  ) {
    this.notifier = notifier ?? new LogReminderNotifier(logger);
  }

  start(): void {
    if (this.timer || this.stopped) return;
    // 启动后先跑一次（部署后尽快对齐），随后按固定间隔扫描
    setTimeout(() => void this.tick("startup"), 5_000).unref();
    this.timer = setInterval(() => void this.tick("interval"), this.intervalMs);
    this.timer.unref?.();
    this.logger.info({ intervalMs: this.intervalMs }, "reminder scheduler started");
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(trigger: "startup" | "interval" | "manual"): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const counters = await reconcileReminders();
      const delivered = await deliverDueReminders(this.notifier);
      if (counters.inserted || counters.cancelled || counters.resolved || counters.rescheduled || delivered) {
        this.logger.info({ trigger, ...counters, delivered }, "reminder scan completed with changes");
      }
    } catch (error) {
      this.logger.error({ err: error, trigger }, "reminder scan failed");
    } finally {
      this.running = false;
    }
  }
}
