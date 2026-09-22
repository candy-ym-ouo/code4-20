import { pool } from "./db.js";
import { runReminderScan } from "./reminders.js";

const TICK_INTERVAL_MS = 60 * 1000;
// postgres int8 常量 '72636963616c7374'（"handrclsd" 的十六进制）
const SCHEDULER_LOCK = "x'72636963616c7374'::bigint";

// 提醒重算不需要事务内同步执行：用短延时合并同一请求里的多次库存变更。
let refreshTimer: NodeJS.Timeout | null = null;

export function scheduleReminderRefresh(delayMs = 5_000): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void reconcileOnce("data-change");
  }, delayMs);
  refreshTimer.unref?.();
}

async function reconcileOnce(reason: string): Promise<void> {
  try {
    const stats = await runReminderScan();
    if (stats.inserted || stats.cancelled || stats.superseded || stats.delivered) {
      console.info(`[reminders] ${reason}: ${JSON.stringify(stats)}`);
    }
  } catch (error) {
    console.error(`[reminders] ${reason} failed`, error);
  }
}

/**
 * 进程内提醒调度器。
 * 使用 PostgreSQL 会话级咨询锁选主：多实例部署时只有拿到锁的实例执行扫描，
 * 从实例持续尝试，主实例退出后自动接管。
 */
export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private holdsLock = false;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    this.timer.unref?.();
    // 启动后稍等再跑首次扫描，避开迁移与服务启动高峰。
    setTimeout(() => void this.tick(), 10_000).unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (this.holdsLock) {
      try {
        await pool.query(`SELECT pg_advisory_unlock(${SCHEDULER_LOCK})`);
      } catch {
        // 连接随进程关闭即可
      }
      this.holdsLock = false;
    }
  }

  private async tick(): Promise<void> {
    try {
      if (!this.holdsLock) {
        const locked = await pool.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(${SCHEDULER_LOCK}) AS locked`
        );
        this.holdsLock = locked.rows[0]?.locked ?? false;
        if (!this.holdsLock) return;
      }
      await reconcileOnce("scheduled-scan");
    } catch (error) {
      // 丢锁（例如连接被池回收）时下个 tick 重新选主。
      this.holdsLock = false;
      console.error("[reminders] scheduler tick failed", error);
    }
  }
}

export const reminderScheduler = new ReminderScheduler();
