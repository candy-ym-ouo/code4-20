/**
 * 时区相关纯函数。
 *
 * 批次有效期是 date（无时区），"距到期还有 N 天"必须在操作员设置的本地时区下判断；
 * 每日通知时刻（如 09:00）同样按该时区换算成 UTC 的 timestamptz 存储。
 */

export type LocalDateParts = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  weekday: number; // 1=Mon ... 7=Sun
};

/** IANA 时区是否被运行时支持 */
export function isValidTimeZone(timeZone: string): boolean {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  return typeof supported === "function" ? supported.call(Intl, "timeZone").includes(timeZone) : false;
}

function partsFromFormatter(formatter: Intl.DateTimeFormat, instant: Date): Record<string, string> {
  const parts = formatter.formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return map;
}

/** 某一 UTC 时刻在指定时区下的本地日历日 */
export function localDateParts(instant: Date, timeZone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  });
  const p = partsFromFormatter(formatter, instant);
  const weekdays: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    weekday: weekdays[p.weekday ?? ""] ?? 1
  };
}

/** 指定时区下"今天"的日期部分 */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): LocalDateParts {
  return localDateParts(now, timeZone);
}

export function localDateToIso(parts: LocalDateParts): string {
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

/**
 * 将指定时区下某本地日历日的 HH:MM 换算为 UTC Date。
 *
 * Intl 只能做 UTC -> 本地的单向换算，反向用两次 12:00 UTC 猜测逐步收敛。
 * 由于 date + HH:MM 在任意时区都不会落到 DST 跳跃间隙的 12 小时之外，该方法稳定。
 */
export function zonedDateTimeToUtc(
  parts: { year: number; month: number; day: number },
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const targetWallMinutes = hour * 60 + minute;
  // 以该本地日 12:00 对应的 UTC 时刻为锚点，先算近似偏移
  const noonUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0);
  const noonOffsetMinutes = wallOffsetMinutes(new Date(noonUtc), timeZone);
  let guess = new Date(noonUtc - noonOffsetMinutes * 60_000 + (targetWallMinutes - 12 * 60) * 60_000);
  // 再用猜测时刻所在的实际偏移校正一次，处理跨 DST 边界的情况
  const guessOffsetMinutes = wallOffsetMinutes(guess, timeZone);
  const actualWallMinutes = (guess.getTime() / 60_000 + guessOffsetMinutes) % (24 * 60);
  guess = new Date(guess.getTime() + (targetWallMinutes - actualWallMinutes) * 60_000);
  return guess;
}

/** 某 UTC 时刻相对指定时区的墙钟偏移（分钟，东部为正） */
export function wallOffsetMinutes(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const p = partsFromFormatter(formatter, instant);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

export function parseTimeOfTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`INVALID_TIME_OF_DAY:${value}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** 本地日期加/减天数（基于 UTC Date 的安全换算，结果只取日期部分） */
export function addLocalDays(parts: LocalDateParts, days: number): LocalDateParts {
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day) + days * 86_400_000;
  const d = new Date(utc);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: ((d.getUTCDay() + 6) % 7) + 1
  };
}

/**
 * 临期提醒的计划触发本地日：到期日往前 leadDays 天。
 * 例如到期 2026-10-22、leadDays=30 -> 2026-09-22 的 notifyAtTime。
 */
export function expiryTriggerDate(
  expiryParts: LocalDateParts,
  leadDays: number
): LocalDateParts {
  return addLocalDays(expiryParts, -leadDays);
}
