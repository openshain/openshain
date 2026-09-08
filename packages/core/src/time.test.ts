import { describe, expect, test } from "bun:test";
import { businessDate, companyTime, hostTimezone, isTimezone } from "./time.ts";

describe("the company's clock", () => {
  test("the business date is the date where the company is, not where the machine is", () => {
    // 2026-09-09 15:30 UTC is already the 10th in Tokyo and still the 9th in New York.
    const at = new Date("2026-09-09T15:30:00Z");

    expect(businessDate("Asia/Tokyo", at)).toBe("2026-09-10");
    expect(businessDate("UTC", at)).toBe("2026-09-09");
    expect(businessDate("America/New_York", at)).toBe("2026-09-09");
  });

  test("a date that has just begun in the company's timezone is that date", () => {
    // 00:30 in Tokyo on the first of the month: the effective date has arrived, even though
    // the machine's own clock still says the previous month.
    const at = new Date("2026-03-31T15:30:00Z");

    expect(businessDate("Asia/Tokyo", at)).toBe("2026-04-01");
    expect(businessDate("UTC", at)).toBe("2026-03-31");
  });

  test("the moment is written with the company's offset", () => {
    const at = new Date("2026-09-09T15:30:11Z");

    expect(companyTime("Asia/Tokyo", at)).toBe("2026-09-10T00:30:11+09:00");
    expect(companyTime("UTC", at)).toBe("2026-09-09T15:30:11+00:00");
  });

  test("midnight is written as 00, not 24", () => {
    expect(companyTime("Asia/Tokyo", new Date("2026-09-09T15:00:00Z"))).toContain("T00:00:00");
  });

  test("a name that is not a timezone is refused, and the machine's own is usable", () => {
    expect(isTimezone("Asia/Tokyo")).toBe(true);
    expect(isTimezone("UTC")).toBe(true);
    expect(isTimezone("Nowhere/Nothing")).toBe(false);
    expect(isTimezone("")).toBe(false);
    expect(isTimezone(hostTimezone())).toBe(true);
  });
});
