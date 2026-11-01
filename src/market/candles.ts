import type { Candle } from "./indicators.js";

// Real candles, free and without a key: Yahoo for stocks, forex and futures, Binance for crypto and intraday gold. Both
// are called with plain fetch. Yahoo answers 429 to clients that pose as a browser, so don't add a User-Agent. Only
// closed candles leave this file; a candle still forming would change the analysis until it closes.

export const MARKETS = ["idx", "us", "forex", "gold", "crypto", "other"] as const;
export type Market = (typeof MARKETS)[number];

export type Timeframe = { label: string; unit: "m" | "h" | "d" | "w" | "mo"; count: number; seconds: number };

export type Series = {
  symbol: string;
  name: string;
  currency: string;
  kind: string;
  source: string;
  /** The exchange's zone: its days and weeks are the ones traders see. */
  timeZone: string;
  /** Seconds east of UTC there right now; history needs `timeZone`, because this changes with daylight saving. */
  utcOffset: number;
  /** The latest known price, which may belong to a candle that hasn't closed. */
  price: number;
  priceTime: number;
  candles: Candle[];
};

const MAX_CANDLES = 5000;
const MAX_PAGES = 8;
const TIMEOUT = 15_000;
const DAY = 86_400;
const WEEK = 7 * DAY;
const FIRST_MONDAY = 4 * DAY; // 1970-01-05, counted from the Thursday the epoch starts on
const UNREADABLE = "The market data provider sent something unreadable. Tell them to try again in a moment.";

const SECONDS = { m: 60, h: 3600, d: DAY, w: WEEK, mo: 2_629_800 }; // a month's length only ranks timeframes
const UNITS = new Map<string, Timeframe["unit"]>(
  Object.entries({
    m: "m", min: "m", mnt: "m", menit: "m", minute: "m", minutes: "m",
    h: "h", hr: "h", jam: "h", hour: "h", hours: "h",
    d: "d", hari: "d", day: "d", days: "d",
    w: "w", wk: "w", minggu: "w", week: "w", weeks: "w",
    mo: "mo", mon: "mo", bulan: "mo", month: "mo", months: "mo",
  }),
);
const WORDS = new Map(Object.entries({ hourly: "1h", daily: "1d", harian: "1d", weekly: "1w", mingguan: "1w", monthly: "1mo", bulanan: "1mo" }));
const METATRADER = new Map<string, Timeframe["unit"]>(Object.entries({ M: "m", H: "h", D: "d", W: "w", MN: "mo" }));
const MONTHS_IN_CAPITALS = [1, 3, 6, 12]; // on charts 1M and 3M are months, but 5M and 15M are minutes

const isIntraday = (unit: Timeframe["unit"]) => unit === "m" || unit === "h";

export function parseTimeframe(raw: string): Timeframe {
  const text = WORDS.get(raw.trim().toLowerCase()) ?? raw.trim();
  const metatrader = text.match(/^(MN|M|H|D|W)(\d+)$/i); // M15, H4, D1, MN1
  const plain = text.match(/^(\d+)\s*([a-zA-Z]+)$/);
  const count = Number(metatrader?.[2] ?? plain?.[1]);
  const months = plain?.[2] === "M" && MONTHS_IN_CAPITALS.includes(count);
  const unit = metatrader ? METATRADER.get(metatrader[1].toUpperCase()) : months ? "mo" : UNITS.get(plain?.[2].toLowerCase() ?? "");
  if (!unit || !count) throw new Error(`Unknown timeframe "${raw}". Use forms like 5m, 15m, 1h, 4h, 1d, 1w or 1mo; there's nothing shorter than 1m.`);
  const seconds = count * SECONDS[unit];
  if (isIntraday(unit) && seconds >= DAY) {
    // A stock's day isn't 24 hours, so counting hours past one day would just give daily candles under the wrong name.
    if (seconds % DAY) throw new Error(`Timeframe "${raw}" isn't a whole number of days. Use 1d, 2d, 3d and so on.`);
    return parseTimeframe(`${seconds / DAY}d`);
  }
  return { label: `${count}${unit}`, unit, count, seconds };
}

const LADDER = ["5m", "15m", "1h", "4h", "1d", "1w", "1mo"].map(parseTimeframe);

/** The timeframe to read the bigger picture from; undefined above monthly. */
export function higherTimeframe(tf: Timeframe): Timeframe | undefined {
  return LADDER.find((higher) => higher.seconds >= tf.seconds * 4);
}

/** The longest available interval that `tf` is a whole number of. Days only merge days: a week isn't seven trading days. */
function sourceFor<S extends { seconds: number }>(tf: Timeframe, sources: S[]): S {
  const fits = (s: S) => (isIntraday(tf.unit) ? tf.seconds % s.seconds === 0 : tf.unit === "d" ? s.seconds === DAY : s.seconds >= DAY && tf.seconds % s.seconds === 0);
  return sources.filter(fits).at(-1) ?? sources.at(-1)!;
}

function merged(group: Candle[]): Candle {
  return {
    time: group[0].time,
    open: group[0].open,
    high: Math.max(...group.map((c) => c.high)),
    low: Math.min(...group.map((c) => c.low)),
    close: group.at(-1)!.close,
    volume: group.reduce((sum, c) => sum + c.volume, 0),
  };
}

type Clock = { timeZone: string; utcOffset: number; now: number; tradingDays: number };

/** Midnight of the exchange's calendar date, written as UTC. Only the zone can give this: offsets move with daylight saving. */
function localDates(timeZone: string): (time: number) => number {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (time) => Date.parse(`${format.format(time * 1000)}T00:00:00Z`) / 1000;
}

/**
 * Builds a timeframe the source doesn't offer, keeping only candles that have closed by `now`. Intraday candles count
 * from each day's first trade, as on a chart: 4h on a stock starts at the open, not at midnight UTC.
 */
export function resample(candles: Candle[], tf: Timeframe, { timeZone, utcOffset, now, tradingDays }: Clock): Candle[] {
  if (tf.unit === "d") {
    // Trading days have no calendar to follow. Counted back from the newest so every group is whole.
    const start = candles.length % tf.count;
    return Array.from({ length: Math.floor(candles.length / tf.count) }, (_, i) => merged(candles.slice(start + i * tf.count, start + (i + 1) * tf.count)));
  }
  const localDate = localDates(timeZone);
  const groups = new Map<number, { candles: Candle[]; closesAt: number }>();
  const dayStart = new Map<number, number>();
  for (const candle of candles) {
    const local = localDate(candle.time);
    const day = local / DAY;
    let key: number;
    let closesAt: number;
    if (isIntraday(tf.unit)) {
      if (!dayStart.has(day)) dayStart.set(day, candle.time);
      const slot = Math.floor((candle.time - dayStart.get(day)!) / tf.seconds);
      key = day * 10_000 + slot;
      closesAt = dayStart.get(day)! + (slot + 1) * tf.seconds;
    } else if (tf.unit === "w") {
      const period = Math.floor(Math.floor((local - FIRST_MONDAY) / WEEK) / tf.count);
      key = period;
      closesAt = FIRST_MONDAY + (period * tf.count + tf.count - 1) * WEEK + tradingDays * DAY - utcOffset;
    } else {
      const date = new Date(local * 1000);
      const period = Math.floor((date.getUTCFullYear() * 12 + date.getUTCMonth()) / tf.count);
      key = period;
      const next = (period + 1) * tf.count;
      closesAt = Date.UTC(Math.floor(next / 12), next % 12) / 1000 - utcOffset;
    }
    const group = groups.get(key);
    if (group) group.candles.push(candle);
    else groups.set(key, { candles: [candle], closesAt });
  }
  const list = [...groups.values()];
  return list.filter((g, i) => i < list.length - 1 || g.closesAt <= now).map((g) => merged(g.candles));
}

async function request(url: string): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  } catch {
    throw new Error("Couldn't reach the market data provider. Tell them to try again in a moment.");
  }
}

async function bodyOf<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(UNREADABLE);
  }
}

function refused(res: Response): Error {
  return new Error(
    res.status === 429 || res.status === 418
      ? "The market data provider is limiting requests from this server right now. Tell them to try again in a few minutes."
      : `Market data isn't available right now (HTTP ${res.status}).`,
  );
}

const YAHOO = "https://query1.finance.yahoo.com";
const YAHOO_SOURCES = [
  { interval: "1m", seconds: 60, days: 7 },
  { interval: "2m", seconds: 120, days: 59 },
  { interval: "5m", seconds: 300, days: 59 },
  { interval: "15m", seconds: 900, days: 59 },
  { interval: "30m", seconds: 1800, days: 59 },
  { interval: "60m", seconds: 3600, days: 729 },
  { interval: "1d", seconds: DAY, days: 0 }, // weeks and months are built from days: Yahoo's own end in a half-finished candle
];
const KINDS: Record<string, string> = { EQUITY: "stock", ETF: "ETF", CURRENCY: "forex", CRYPTOCURRENCY: "crypto", FUTURE: "futures", INDEX: "index", MUTUALFUND: "fund" };

type YahooResult = {
  meta: {
    symbol: string;
    currency?: string;
    instrumentType?: string;
    longName?: string;
    shortName?: string;
    exchangeTimezoneName?: string;
    gmtoffset?: number;
    regularMarketPrice?: number;
    regularMarketTime?: number;
    currentTradingPeriod?: { regular?: { start: number; end: number } };
  };
  timestamp?: number[];
  indicators?: { quote?: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume?: (number | null)[] }[] };
};

/** Yahoo's rows without gaps, and without the last bar when it's still forming or is a stub stamped at the last trade. */
export function yahooCandles(result: YahooResult, seconds: number, now: number): Candle[] {
  const quote = result.indicators?.quote?.[0];
  const rows: Candle[] = [];
  (result.timestamp ?? []).forEach((time, i) => {
    const [open, high, low, close] = [quote?.open[i], quote?.high[i], quote?.low[i], quote?.close[i]];
    if (open == null || high == null || low == null || close == null) return;
    rows.push({ time, open, high, low, close, volume: quote?.volume?.[i] ?? 0 });
  });
  if (seconds >= DAY) {
    const session = result.meta.currentTradingPeriod?.regular;
    const newest = rows.at(-1);
    if (!newest) return rows;
    // A row before the session on file has finished; one after it can't be judged by it, as over a weekend.
    const closesAt = !session || newest.time >= session.end ? newest.time + DAY : newest.time < session.start ? 0 : session.end;
    if (now < closesAt) rows.pop();
    return rows;
  }
  while (rows.length > 1) {
    const [previous, last] = rows.slice(-2);
    if ((last.time - previous.time) % seconds === 0 && last.time + seconds <= now) break;
    rows.pop();
  }
  return rows;
}

/** Ways a name could be meant, for when a symbol doesn't exist. Best effort: it must never hide the real error. */
async function suggestions(query: string): Promise<string> {
  try {
    const res = await request(`${YAHOO}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0`);
    if (!res.ok) return "";
    const { quotes = [] } = await bodyOf<{ quotes?: { symbol: string; shortname?: string; exchDisp?: string }[] }>(res);
    const list = quotes.map((q) => `${q.symbol} (${[q.shortname, q.exchDisp].filter(Boolean).join(", ")})`);
    return list.length ? ` Did you mean: ${list.join("; ")}?` : "";
  } catch {
    return "";
  }
}

async function yahooSeries(symbol: string, tf: Timeframe, now: number, asked = symbol): Promise<Series> {
  const source = sourceFor(tf, YAHOO_SOURCES);
  const from = source.days ? now - source.days * DAY : 0;
  const res = await request(`${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${source.interval}&period1=${from}&period2=${now}&includePrePost=false`);
  if (res.status === 404) throw new Error(`No market data for "${symbol}".${await suggestions(asked)}`);
  if (!res.ok) throw refused(res);
  const body = await bodyOf<{ chart?: { result?: YahooResult[] } }>(res);
  const result = body.chart?.result?.[0];
  if (!result) throw new Error(`No market data for "${symbol}".${await suggestions(asked)}`);
  const { meta } = result;
  const closed = yahooCandles(result, source.seconds, now);
  const utcOffset = meta.gmtoffset ?? 0;
  const timeZone = meta.exchangeTimezoneName ?? "UTC";
  const tradingDays = meta.instrumentType === "CRYPTOCURRENCY" ? 7 : 5;
  const candles = tf.seconds === source.seconds ? closed : resample(closed, tf, { timeZone, utcOffset, now, tradingDays });
  return {
    symbol: meta.symbol,
    name: meta.longName ?? meta.shortName ?? meta.symbol,
    currency: meta.currency ?? "",
    kind: KINDS[meta.instrumentType ?? ""] ?? "instrument",
    source: "Yahoo Finance (may be delayed)",
    timeZone,
    utcOffset,
    price: meta.regularMarketPrice ?? closed.at(-1)?.close ?? NaN,
    priceTime: meta.regularMarketTime ?? closed.at(-1)?.time ?? now,
    candles: candles.slice(-MAX_CANDLES),
  };
}

const VENUES = { spot: "https://api.binance.com/api/v3/klines", futures: "https://fapi.binance.com/fapi/v1/klines" };
const BINANCE_SOURCES = [
  ["1m", 60], ["3m", 180], ["5m", 300], ["15m", 900], ["30m", 1800], ["1h", 3600], ["2h", 7200], ["4h", 14_400], ["6h", 21_600],
  ["8h", 28_800], ["12h", 43_200], ["1d", DAY], ["1w", WEEK],
].map(([interval, seconds]) => ({ interval: interval as string, seconds: seconds as number }));

type Kline = [number, string, string, string, string, string, number];

/** Candles from one Binance market, or undefined when it doesn't list the pair. */
async function binanceSeries(venue: keyof typeof VENUES, pair: string, tf: Timeframe, now: number): Promise<Series | undefined> {
  const source = tf.unit === "mo" ? { interval: "1M", seconds: SECONDS.mo } : sourceFor(tf, BINANCE_SOURCES);
  const wanted = (MAX_CANDLES * tf.seconds) / source.seconds;
  let rows: Kline[] = [];
  let end: number | undefined;
  for (let page = 0; page < MAX_PAGES && rows.length < wanted; page++) {
    const res = await request(`${VENUES[venue]}?symbol=${pair}&interval=${source.interval}&limit=1000${end ? `&endTime=${end}` : ""}`);
    if (res.status === 400) return undefined;
    if (!res.ok) throw refused(res);
    const batch = await bodyOf<Kline[]>(res);
    if (!Array.isArray(batch)) throw new Error(UNREADABLE);
    rows = [...batch, ...rows];
    if (batch.length < 1000) break;
    end = batch[0][0] - 1;
  }
  const newest = rows.at(-1);
  if (!newest) return undefined;
  const closed = rows
    .filter((row) => row[6] < now * 1000)
    .map(([time, open, high, low, close, volume]) => ({ time: time / 1000, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) }));
  const candles = tf.seconds === source.seconds ? closed : resample(closed, tf, { timeZone: "UTC", utcOffset: 0, now, tradingDays: 7 });
  const quote = pair.match(/(USDT|USDC|FDUSD|BTC|ETH|BNB|EUR|TRY|BRL|JPY|GBP|AUD|MXN|ZAR|PLN|UAH|ARS)$/)?.[1] ?? "";
  return {
    symbol: pair,
    name: `${quote ? `${pair.slice(0, pair.length - quote.length)} / ${quote}` : pair}${venue === "futures" ? " perpetual" : ""}`,
    currency: /USD/.test(quote) ? "USD" : quote,
    kind: "crypto",
    source: venue === "spot" ? "Binance" : "Binance futures",
    timeZone: "UTC",
    utcOffset: 0,
    price: Number(newest[4]),
    priceTime: Math.min(now, Math.floor(newest[6] / 1000)),
    candles: candles.slice(-MAX_CANDLES),
  };
}

async function cryptoSeries(symbol: string, tf: Timeframe, now: number): Promise<Series> {
  const text = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const stable = text.match(/^(.+?)(USDT|USDC|FDUSD)$/)?.[1];
  // BTCUSD means BTC, but TUSD and GUSD are coins: one letter and USD is never a coin priced in dollars.
  const dollar = text.match(/^(.{2,})USD$/)?.[1];
  const pairs = stable ? [text] : dollar ? [`${text}USDT`, `${dollar}USDT`] : [`${text}USDT`, text];
  for (const venue of ["spot", "futures"] as const) {
    for (const pair of pairs) {
      const series = await binanceSeries(venue, pair, tf, now);
      if (series) return series;
    }
  }
  return yahooSeries(`${stable ?? dollar ?? text}-USD`, tf, now, text);
}

/** Yahoo has no spot gold. Binance's XAUUSDT follows it closely but is young, so long timeframes read COMEX futures. */
async function goldSeries(tf: Timeframe, now: number): Promise<Series> {
  const futures = () => yahooSeries("GC=F", tf, now).then((series) => ({ ...series, kind: "gold", name: "Gold (COMEX futures GC=F, a few dollars from spot XAUUSD)" }));
  if (tf.seconds >= DAY) return futures();
  const series = await binanceSeries("futures", "XAUUSDT", tf, now).catch(() => undefined);
  return series ? { ...series, kind: "gold", name: "Gold (XAU/USD, Binance XAUUSDT perpetual)" } : futures();
}

/** The closed candles of an instrument, however the person named it. Throws a readable message on failure. */
export async function loadSeries(market: Market, symbol: string | undefined, tf: Timeframe, now = Math.floor(Date.now() / 1000)): Promise<Series> {
  const text = symbol?.trim() ?? "";
  if (market === "gold") return goldSeries(tf, now);
  if (!text) throw new Error("Which instrument? Give a symbol.");
  const upper = text.toUpperCase();
  switch (market) {
    case "idx":
      return yahooSeries(`${upper.replace(/^IDX:/, "").replace(/\.JK$/, "")}.JK`, tf, now, text);
    case "us":
      return yahooSeries(upper.replace(/^(NASDAQ|NYSE|AMEX):/, "").replace(/\./g, "-"), tf, now, text);
    case "forex": {
      const pair = upper.replace(/=X$/, "").replace(/[^A-Z]/g, "");
      if (pair === "XAUUSD") return goldSeries(tf, now);
      if (pair.length !== 6) throw new Error(`"${text}" isn't a forex pair. Give two currencies, like EURUSD or USDIDR.`);
      return yahooSeries(`${pair}=X`, tf, now, text);
    }
    case "crypto":
      return cryptoSeries(text, tf, now);
    case "other":
      return yahooSeries(text, tf, now);
  }
}
