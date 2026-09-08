/**
 * The company's clock. Every date the runtime judges against — a decision's effective days, a
 * delegation's validity — is a date in the company's timezone, not in the host's. A workspace
 * carried between a laptop in Tokyo and a container in UTC has to answer the same question the
 * same way, so the timezone is part of the configuration rather than the environment.
 */

/** True when the name is a timezone this runtime knows (`Asia/Tokyo`, `UTC`, ...). */
export function isTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The timezone of the machine, used when the configuration names none. */
export function hostTimezone(): string {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return name && isTimezone(name) ? name : "UTC";
}

/** The business date (`YYYY-MM-DD`) in the company's timezone. */
export function businessDate(timezone: string, at: Date = new Date()): string {
  // en-CA writes a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** The moment as the company reads it: `2026-09-09T14:03:11+09:00`. */
export function companyTime(timezone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const of = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  // "GMT+09:00" for a zone with an offset, "GMT" for UTC itself.
  const zone = of("timeZoneName").replace("GMT", "");
  const hour = of("hour") === "24" ? "00" : of("hour");
  return `${of("year")}-${of("month")}-${of("day")}T${hour}:${of("minute")}:${of("second")}${zone === "" ? "+00:00" : zone}`;
}
