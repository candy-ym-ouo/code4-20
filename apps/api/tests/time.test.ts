import { describe, expect, it } from "vitest";
import {
  addLocalDays,
  expiryTriggerDate,
  localDateParts,
  localDateToIso,
  parseTimeOfTime,
  todayInTimeZone,
  wallOffsetMinutes,
  zonedDateTimeToUtc
} from "../src/lib/time.js";

describe("time zone helpers", () => {
  it("computes the local calendar day in the operator timezone", () => {
    // 2026-09-22 23:30 UTC = 2026-09-23 07:30 上海
    const instant = new Date("2026-09-22T23:30:00Z");
    const shanghai = localDateParts(instant, "Asia/Shanghai");
    expect(localDateToIso(shanghai)).toBe("2026-09-23");
    // 同一时刻 UTC 与洛杉矶仍是 22 日
    expect(localDateToIso(localDateParts(instant, "UTC"))).toBe("2026-09-22");
    expect(localDateToIso(localDateParts(instant, "America/Los_Angeles"))).toBe("2026-09-22");
  });

  it("converts a zoned wall-clock date-time to UTC", () => {
    // 上海 2026-09-23 09:00 -> UTC 01:00（9 月无 DST，偏移 +8）
    const utc = zonedDateTimeToUtc({ year: 2026, month: 9, day: 23 }, 9, 0, "Asia/Shanghai");
    expect(utc.toISOString()).toBe("2026-09-23T01:00:00.000Z");

    // 纽约 2026-07-01 09:00 (EDT, -4) -> UTC 13:00
    const nySummer = zonedDateTimeToUtc({ year: 2026, month: 7, day: 1 }, 9, 0, "America/New_York");
    expect(nySummer.toISOString()).toBe("2026-07-01T13:00:00.000Z");
  });

  it("handles DST transitions for scheduled reminder times", () => {
    // 2026-03-08 is the spring-forward day in the US (02:00 -> 03:00).
    // 09:00 is safely after the jump: EDT -4 -> UTC 13:00
    const spring = zonedDateTimeToUtc({ year: 2026, month: 3, day: 9 }, 9, 0, "America/New_York");
    expect(spring.toISOString()).toBe("2026-03-09T13:00:00.000Z");
    // 冬季 09:00 EST -5 -> UTC 14:00
    const winter = zonedDateTimeToUtc({ year: 2026, month: 12, day: 1 }, 9, 0, "America/New_York");
    expect(winter.toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(wallOffsetMinutes(winter, "America/New_York")).toBe(-300);
  });

  it("adds and subtracts local days for expiry lead windows", () => {
    const expiry = { year: 2026, month: 10, day: 22, weekday: 4 };
    expect(localDateToIso(expiryTriggerDate(expiry, 30))).toBe("2026-09-22");
    expect(localDateToIso(expiryTriggerDate(expiry, 7))).toBe("2026-10-15");
    expect(localDateToIso(expiryTriggerDate(expiry, 0))).toBe("2026-10-22");
    // 跨月/跨年借位
    expect(localDateToIso(addLocalDays({ year: 2026, month: 3, day: 1, weekday: 7 }, -1))).toBe("2026-02-28");
    expect(localDateToIso(addLocalDays({ year: 2026, month: 12, day: 31, weekday: 4 }, 1))).toBe("2027-01-01");
  });

  it("parses HH:MM and reports today consistently", () => {
    expect(parseTimeOfTime("09:00")).toEqual({ hour: 9, minute: 0 });
    expect(() => parseTimeOfTime("9:00")).toThrow();
    const today = todayInTimeZone("Asia/Shanghai", new Date("2026-09-22T23:30:00Z"));
    expect(localDateToIso(today)).toBe("2026-09-23");
  });
});
