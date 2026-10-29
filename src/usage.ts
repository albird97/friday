import { db } from "./db.js";
import { localDay } from "./time.js";

// Claude token use per person, for the admin's /usage report. Group turns count for whoever spoke; errand turns
// count for the person who started the errand.

export type Person = { number: string; name: string };
export type Usage = { input: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; output: number; webSearches: number };

// List prices in USD per million tokens (Claude API docs). Cache writes cost 1.25× input for the 5-minute TTL and 2×
// for the 1-hour one; web search is $10 per 1,000 searches. Unknown models (e.g. a safety fallback) use Opus 5.5.
const PRICES: [prefix: string, input: number, output: number, cacheRead: number][] = [
  ["claude-opus-5-5", 4, 20, 0.2],
  ["claude-sonnet-5-5", 2, 10, 0.2],
  ["claude-haiku-5-5", 0.1, 0.5, 0.01],
  ["claude-fable-5-1", 10, 50, 0.25],
];
const WEB_SEARCH = 10 / 1000;

export function costOf(model: string, u: Usage): number {
  const [, input, output, cacheRead] = PRICES.find(([prefix]) => model.startsWith(prefix)) ?? PRICES[0];
  const perToken = (u.input * input + u.output * output + u.cacheRead * cacheRead + u.cacheWrite5m * input * 1.25 + u.cacheWrite1h * input * 2) / 1e6;
  return perToken + u.webSearches * WEB_SEARCH;
}

export function recordUsage(by: Person, model: string, u: Usage, at = new Date()): void {
  db.prepare(
    `INSERT INTO token_usage (day, number, name, model, input, cache_read, cache_write, cache_write_1h, output, web_searches)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(localDay(at), by.number, by.name, model, u.input, u.cacheRead, u.cacheWrite5m, u.cacheWrite1h, u.output, u.webSearches);
}

type Row = { number: string; name: string; model: string; input: number; cache_read: number; cache_write: number; cache_write_1h: number; output: number; web_searches: number };
type Total = { number: string; name: string; fresh: number; cached: number; output: number; dollars: number };

function totals(fromDay: string, toDay: string): Total[] {
  const rows = db
    .prepare(
      `SELECT number, MAX(name) AS name, model, SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
              SUM(cache_write_1h) AS cache_write_1h, SUM(output) AS output, SUM(web_searches) AS web_searches
         FROM token_usage WHERE day BETWEEN ? AND ? GROUP BY number, model`,
    )
    .all(fromDay, toDay) as Row[];
  const people = new Map<string, Total>();
  for (const r of rows) {
    const t = people.get(r.number) ?? { number: r.number, name: r.name, fresh: 0, cached: 0, output: 0, dollars: 0 };
    t.fresh += r.input + r.cache_write + r.cache_write_1h;
    t.cached += r.cache_read;
    t.output += r.output;
    t.dollars += costOf(r.model, {
      input: r.input,
      cacheRead: r.cache_read,
      cacheWrite5m: r.cache_write,
      cacheWrite1h: r.cache_write_1h,
      output: r.output,
      webSearches: r.web_searches,
    });
    people.set(r.number, t);
  }
  return [...people.values()].sort((a, b) => b.dollars - a.dollars);
}

/** 1234 → "1rb", 2_500_000 → "2,5jt". */
export function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")}jt`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}rb`;
  return String(n);
}

/** 1.234 → "$1,23"; amounts under a cent → "<$0,01". */
export function usd(amount: number): string {
  return amount > 0 && amount < 0.005 ? "<$0,01" : `$${amount.toFixed(2).replace(".", ",")}`;
}

function section(title: string, rows: Total[]): string {
  if (rows.length === 0) return `*${title}*\nBelum ada pemakaian.`;
  const lines = rows.map(
    (r) => `- ${r.name} (+${r.number}): *${usd(r.dollars)}* — baru ${short(r.fresh)} · cache ${short(r.cached)} · balasan ${short(r.output)}`,
  );
  return `*${title}*\n${lines.join("\n")}\nTotal: *${usd(rows.reduce((a, r) => a + r.dollars, 0))}*`;
}

/** The admin's /usage report: today and this month, per person, in estimated dollars and tokens. */
export function usageReport(now = new Date()): string {
  const today = localDay(now);
  const month = today.slice(0, 7);
  return [
    "📊 *Pemakaian Claude per orang*",
    section(`Hari ini (${today})`, totals(today, today)),
    section(`Bulan ini (${month})`, totals(`${month}-01`, `${month}-31`)),
    "_Dolar = perkiraan dari harga resmi per token (termasuk pencarian web), bukan tagihan; angka pasti ada di console.anthropic.com. " +
      "Token: baru = dibaca penuh · cache = dibaca ulang dari cache (jauh lebih murah) · balasan = ditulis Claude._",
  ].join("\n\n");
}
