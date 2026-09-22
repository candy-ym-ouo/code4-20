// 提醒调度使用的时区/时间纯函数。
// “今天”按操作员配置的时区计算，事件在操作员本地 notify_time 投递。

export type LocalDate = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
};

/**
 * 返回 IANA 时区在指定时刻的本地日历日期。
 * 用 en-CA 语言环境取 YYYY-MM-DD，避免手写偏移在 DST 下出错。
 */
export function localDateInTimezone(timezone: string, instant: Date = new Date()): LocalDate {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: value("year"), month: value("month"), day: value("day") };
}

export function localDateString(timezone: string, instant: Date = new Date()): string {
  const { year, month, day } = localDateInTimezone(timezone, instant);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * 将操作员本地某日历日的 HH:MM 转为 UTC 绝对时刻。
 * 用于把 trigger_date + notify_time 排程为 timestamptz。
 */
export function zonedDateTimeUtc(
  date: LocalDate,
  timezone: string,
  hourMinute: string = "09:00"
): Date {
  const [hour = 9, minute = 0] = hourMinute.split(":").map(Number);
  // 先按 UTC 构造，再用时区偏移修正，自动处理 DST 与偏移变化。
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0);
  const offsetMilliseconds = offsetForInstant(new Date(guess), timezone);
  return new Date(guess - offsetMilliseconds);
}

/**
 * 本地日期字符串加减天数，返回 ISO YYYY-MM-DD（UTC 午夜，仅作日期算术）。
 */
export function addDaysToDateString(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  const utc = Date.UTC(year, month - 1, day) + days * 24 * 60 * 60 * 1000;
  return new Date(utc).toISOString().slice(0, 10);
}

function offsetForInstant(instant: Date, timezone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = dtf.formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  let hour = value("hour");
  if (hour === 24) hour = 0; // 某些环境午夜返回 24
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), hour, value("minute"), value("second"));
  return asUtc - instant.getTime();
}

/**
 * 校验 IANA 时区是否可用。
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    localDateInTimezone(timezone, new Date());
    return true;
  } catch {
    return false;
  }
}
