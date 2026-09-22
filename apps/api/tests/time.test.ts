import { describe, expect, it } from "vitest";
import { addDaysToDateString, isValidTimezone, localDateInTimezone, localDateString, zonedDateTimeUtc } from "../src/lib/time.js";

describe("localDateInTimezone", () => {
  it("rolls the calendar date by timezone offset", () => {
    // 2026-01-01 23:30 UTC = 2026-01-02 08:30 上海
    const instant = new Date("2026-01-01T23:30:00.000Z");
    expect(localDateString("Asia/Shanghai", instant)).toBe("2026-01-02");
    expect(localDateString("UTC", instant)).toBe("2026-01-01");
    expect(localDateString("America/New_York", instant)).toBe("2026-01-01");
  });

  it("returns structured parts", () => {
    const instant = new Date("2026-03-09T12:00:00.000Z");
    expect(localDateInTimezone("Asia/Tokyo", instant)).toEqual({ year: 2026, month: 3, day: 9 });
  });
});

describe("zonedDateTimeUtc", () => {
  it("maps local wall time to the correct UTC instant", () => {
    // 上海 09:00（UTC+8）= 01:00 UTC
    const utc = zonedDateTimeUtc({ year: 2026, month: 6, day: 1 }, "Asia/Shanghai", "09:00");
    expect(utc.toISOString()).toBe("2026-06-01T01:00:00.000Z");
  });

  it("handles daylight saving time transitions", () => {
    // 纽约夏令时（UTC-4）：09:00 本地 = 13:00 UTC
    const summer = zonedDateTimeUtc({ year: 2026, month: 7, day: 1 }, "America/New_York", "09:00");
    expect(summer.toISOString()).toBe("2026-07-01T13:00:00.000Z");
    // 纽约冬令时（UTC-5）：09:00 本地 = 14:00 UTC
    const winter = zonedDateTimeUtc({ year: 2026, month: 1, day: 1 }, "America/New_York", "09:00");
    expect(winter.toISOString()).toBe("2026-01-01T14:00:00.000Z");
  });

  it("defaults to 09:00", () => {
    const utc = zonedDateTimeUtc({ year: 2026, month: 12, day: 31 }, "UTC");
    expect(utc.toISOString()).toBe("2026-12-31T09:00:00.000Z");
  });
});

describe("addDaysToDateString", () => {
  it("adds and subtracts across month boundaries", () => {
    expect(addDaysToDateString("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysToDateString("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysToDateString("2026-12-30", 5)).toBe("2027-01-04");
  });
});

describe("isValidTimezone", () => {
  it("accepts IANA zones and rejects junk", () => {
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Asia/FooBar")).toBe(false);
    expect(isValidTimezone("GMT+8")).toBe(false);
  });
});
