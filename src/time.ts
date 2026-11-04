import { config } from "./config.js";

const dateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: config.TIMEZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const offset = new Intl.DateTimeFormat("en-GB", { timeZone: config.TIMEZONE, timeZoneName: "longOffset" });

/** "Thu 29 Oct 2026, 14:05" in the configured timezone. */
export function formatDateTime(date: Date): string {
  return dateTime.format(date);
}

/** Today's date as YYYY-MM-DD in the configured timezone. */
export function localDay(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: config.TIMEZONE }).format(date);
}

/** "Thu 29 Oct 2026, 14:05 (Asia/Jakarta, GMT+07:00)" — stamped on each incoming message. */
export function nowStamp(date = new Date()): string {
  const zone = offset.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${formatDateTime(date)} (${config.TIMEZONE}, ${zone})`;
}

/** How far the configured timezone is ahead of UTC at `date`, in milliseconds. */
function zoneOffset(date: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: config.TIMEZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(date)
      .map((p) => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Reads "2026-11-04T07:00" (or "2026-11-04", or with seconds) as a time in the configured timezone. A value that
 * carries its own offset or "Z" is read as given. Throws on anything else.
 */
export function fromLocal(text: string): Date {
  const value = text.trim();
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (!m) throw new Error(`"${text}" isn't a date-time like 2026-11-04T07:00.`);
  const [year, month, day, hour = 0, minute = 0, second = 0] = m.slice(1).map((part) => (part === undefined ? undefined : Number(part))) as number[];
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(guess);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) throw new Error(`"${text}" isn't a real date-time.`);
  // Twice, so a time next to a daylight-saving change still lands on the right offset.
  const first = guess - zoneOffset(new Date(guess));
  return new Date(guess - zoneOffset(new Date(first)));
}
