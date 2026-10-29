import { db } from "./db.js";
import { localDay } from "./time.js";

// Claude token use per person, for the admin's /usage report. Group turns count for whoever spoke; errand turns
// count for the person who started the errand.

export type Person = { number: string; name: string };
export type Tokens = { input: number; cacheRead: number; cacheWrite: number; output: number };

export function recordUsage(by: Person, model: string, t: Tokens, at = new Date()): void {
  db.prepare(
    "INSERT INTO token_usage (day, number, name, model, input, cache_read, cache_write, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(localDay(at), by.number, by.name, model, t.input, t.cacheRead, t.cacheWrite, t.output);
}

type Row = { number: string; name: string; input: number; cache_read: number; cache_write: number; output: number };

function totals(fromDay: string, toDay: string): Row[] {
  return db
    .prepare(
      `SELECT number, MAX(name) AS name, SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
              SUM(output) AS output
         FROM token_usage WHERE day BETWEEN ? AND ?
        GROUP BY number ORDER BY SUM(input + cache_read + cache_write + output) DESC`,
    )
    .all(fromDay, toDay) as Row[];
}

/** 1234 → "1rb", 2_500_000 → "2,5jt". */
export function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")}jt`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}rb`;
  return String(n);
}

function section(title: string, rows: Row[]): string {
  if (rows.length === 0) return `*${title}*\nBelum ada pemakaian.`;
  const sum = (r: Row) => r.input + r.cache_read + r.cache_write + r.output;
  const lines = rows.map(
    (r) => `- ${r.name} (+${r.number}): *${short(sum(r))}* — baru ${short(r.input + r.cache_write)} · cache ${short(r.cache_read)} · balasan ${short(r.output)}`,
  );
  return `*${title}*\n${lines.join("\n")}\nTotal: *${short(rows.reduce((a, r) => a + sum(r), 0))}*`;
}

/** The admin's /usage report: today and this month, per person. */
export function usageReport(now = new Date()): string {
  const today = localDay(now);
  const month = today.slice(0, 7);
  return [
    "📊 *Pemakaian token Claude per orang*",
    section(`Hari ini (${today})`, totals(today, today)),
    section(`Bulan ini (${month})`, totals(`${month}-01`, `${month}-31`)),
    "_baru = token yang dibaca penuh · cache = dibaca ulang dari cache (jauh lebih murah) · balasan = token yang ditulis Claude_",
  ].join("\n\n");
}
