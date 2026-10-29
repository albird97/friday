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
