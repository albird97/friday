import { ADMIN, claude } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import sharp from "sharp";
import { handleIncoming, type Incoming } from "../src/bot.js";
import {
  analyze,
  backtest,
  breakoutEntry,
  confluenceAt,
  confluenceEntry,
  exitOf,
  hasEdge,
  HOLD,
  levelsAt,
  levelsOf,
  oddsOf,
  rangeForecast,
  roundPrice,
  stopFor,
  study,
  trendAt,
  type Analysis,
} from "../src/market/analysis.js";
import { higherTimeframe, loadSeries, parseTimeframe, resample, yahooCandles, type Series } from "../src/market/candles.js";
import { chartOf, svgOf } from "../src/market/chart.js";
import { adx, atr, ema, macdHistogram, obv, rsi, type Candle } from "../src/market/indicators.js";
import { reportOf } from "../src/market/report.js";
import { runTool, toolParams } from "../src/tools.js";
import type { Outbox } from "../src/types.js";

const HOUR = 3600;
const DAY = 86_400;
const MONDAY = Date.UTC(2026, 10, 2, 2) / 1000; // 09:00 in Jakarta, when the IDX opens
const JAKARTA = 7 * HOUR;
const OLD = Date.UTC(2020, 0, 6) / 1000; // far enough back that every candle has closed

const jakarta = (now: number) => ({ timeZone: "Asia/Jakarta", utcOffset: JAKARTA, now, tradingDays: 5 });
const utc = (now: number, tradingDays = 7) => ({ timeZone: "UTC", utcOffset: 0, now, tradingDays });

const candle = (time: number, close: number, over: Partial<Candle> = {}): Candle => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 1000, ...over });
const days = (count: number, start = OLD) => Array.from({ length: count }, (_, i) => candle(start + i * DAY, 100 + i));

/** A repeatable random walk with no drift, so no rule should find an edge in it. */
function walk(length: number, seed = 7, start = 1000): Candle[] {
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let close = start;
  return Array.from({ length }, (_, i) => {
    const open = close;
    close = open * (1 + (random() - 0.5) * 0.04);
    return { time: OLD + i * DAY, open, high: Math.max(open, close) * (1 + random() * 0.01), low: Math.min(open, close) * (1 - random() * 0.01), close, volume: 1000 + random() * 1000 };
  });
}

const seriesOf = (candles: Candle[], symbol = "TEST", kind = "stock"): Series => ({
  symbol,
  name: "Test Corp",
  currency: "USD",
  kind,
  source: "test",
  timeZone: "UTC",
  utcOffset: 0,
  price: candles.at(-1)!.close,
  priceTime: candles.at(-1)!.time,
  candles,
});
const analysed = (candles: Candle[], symbol?: string) => analyze(seriesOf(candles, symbol), parseTimeframe("1d"), candles.at(-1)!.time + DAY);

function yahoo(candles: Candle[], meta: Record<string, unknown> = {}): Response {
  const column = (key: "open" | "high" | "low" | "close" | "volume") => candles.map((c) => c[key]);
  const quote = { open: column("open"), high: column("high"), low: column("low"), close: column("close"), volume: column("volume") };
  return Response.json({
    chart: {
      result: [{ meta: { symbol: "TEST", currency: "IDR", instrumentType: "EQUITY", longName: "Test Tbk", exchangeTimezoneName: "Asia/Jakarta", gmtoffset: JAKARTA, regularMarketPrice: 123, regularMarketTime: OLD, ...meta }, timestamp: candles.map((c) => c.time), indicators: { quote: [quote] } }],
    },
  });
}

const kline = (c: Candle, seconds: number) => [c.time * 1000, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), (c.time + seconds) * 1000 - 1];

// Market data stand-in; everything else (the Claude API) goes to the real fetch.
const realFetch = globalThis.fetch;
let market: (url: URL) => Response | undefined = () => undefined;
let requests: URL[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (!/yahoo\.com|binance\.com/.test(url.hostname)) return realFetch(input, init);
  requests.push(url);
  return market(url) ?? new Response("{}", { status: 404 });
}) as typeof fetch;

beforeEach(() => {
  claude.reset();
  market = () => undefined;
  requests = [];
});

describe("indicators", () => {
  it("seeds an EMA with the average of its first values", () => {
    assert.deepEqual(ema([2, 4, 6, 8], 3).slice(2), [4, 6]);
  });

  it("computes RSI as Wilder defined it", () => {
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    assert.ok(Number.isNaN(rsi(closes)[13]));
    assert.equal(rsi(closes)[14].toFixed(2), "70.46");
  });

  it("measures ATR from true range, gaps included", () => {
    const flat = Array.from({ length: 20 }, (_, i) => candle(i, 100));
    assert.equal(atr(flat).at(-1), 2);
    const gapped = [...flat, candle(20, 110, { high: 111, low: 109 })];
    assert.equal(atr(gapped).at(-1)!.toFixed(4), ((2 * 13 + 11) / 14).toFixed(4)); // 111 is 11 above the last close of 100
  });

  it("reads a straight rise as the strongest possible trend", () => {
    const { adx: strength, plusDi, minusDi } = adx(days(60));
    assert.equal(strength.at(-1), 100);
    assert.ok(plusDi.at(-1)! > 0);
    assert.equal(minusDi.at(-1), 0);
  });

  it("has no MACD on a flat market, and OBV follows the closes", () => {
    assert.equal(macdHistogram(new Array(60).fill(10)).at(-1), 0);
    assert.deepEqual(obv([candle(0, 10), candle(1, 11), candle(2, 9)]), [0, 1000, 0]);
  });

  it("never changes an old value when new candles arrive", () => {
    const full = walk(400);
    const part = full.slice(0, 300);
    const same = (a: number[], b: number[]) => a.forEach((value, i) => assert.ok(Object.is(value, b[i]), `index ${i}`));
    same(rsi(part.map((c) => c.close)), rsi(full.map((c) => c.close)));
    same(atr(part), atr(full));
    same(adx(part).adx, adx(full).adx);
    same(macdHistogram(part.map((c) => c.close)), macdHistogram(full.map((c) => c.close)));
  });
});

describe("timeframes", () => {
  const label = (text: string) => parseTimeframe(text).label;

  it("reads the ways traders write them", () => {
    assert.equal(label("15m"), "15m");
    assert.equal(label("M15"), "15m");
    assert.equal(label("H4"), "4h");
    assert.equal(label("4 jam"), "4h");
    assert.equal(label("D1"), "1d");
    assert.equal(label("harian"), "1d");
    assert.equal(label("weekly"), "1w");
    assert.equal(label("MN1"), "1mo");
    assert.equal(label("3mo"), "3mo");
  });

  it("reads capital M as months only where that's what traders mean", () => {
    assert.equal(label("1M"), "1mo");
    assert.equal(label("3M"), "3mo");
    assert.equal(label("1m"), "1m");
    assert.equal(label("5M"), "5m");
    assert.equal(label("15M"), "15m");
    assert.equal(label("30M"), "30m");
  });

  it("turns whole days of hours into days, and refuses the rest", () => {
    assert.equal(label("48h"), "2d");
    assert.equal(label("2880m"), "2d");
    assert.equal(label("24h"), "1d");
    assert.throws(() => parseTimeframe("36h"), /whole number of days/);
  });

  it("refuses what it can't read", () => {
    assert.throws(() => parseTimeframe("30s"), /Unknown timeframe/);
    assert.throws(() => parseTimeframe("soon"), /Unknown timeframe/);
    assert.throws(() => parseTimeframe("0h"), /Unknown timeframe/);
    assert.throws(() => parseTimeframe("constructor"), /Unknown timeframe/);
    assert.throws(() => parseTimeframe("1constructor"), /Unknown timeframe/);
  });

  it("looks at least four times higher for the bigger picture", () => {
    const higher = (text: string) => higherTimeframe(parseTimeframe(text))?.label;
    assert.equal(higher("15m"), "1h");
    assert.equal(higher("1h"), "4h");
    assert.equal(higher("4h"), "1d");
    assert.equal(higher("1d"), "1w");
    assert.equal(higher("1w"), "1mo");
    assert.equal(higher("1mo"), undefined);
  });
});

describe("closed candles", () => {
  it("skips Yahoo's empty rows", () => {
    const rows = {
      meta: { symbol: "X" },
      timestamp: [0, DAY, 2 * DAY],
      indicators: { quote: [{ open: [1, null, 3], high: [1, null, 3], low: [1, null, 3], close: [1, null, 3], volume: [5, null, 5] }] },
    };
    assert.deepEqual(yahooCandles(rows, DAY, 10 * DAY).map((c) => c.close), [1, 3]);
  });

  it("drops an intraday candle still forming, and the stub Yahoo stamps at the last trade", () => {
    const rows = (times: number[]) => ({ meta: { symbol: "X" }, timestamp: times, indicators: { quote: [{ open: times.map(() => 1), high: times.map(() => 1), low: times.map(() => 1), close: times.map(() => 1) }] } });
    assert.equal(yahooCandles(rows([0, HOUR, 2 * HOUR]), HOUR, 2 * HOUR + 60).length, 2);
    assert.equal(yahooCandles(rows([0, HOUR, 2 * HOUR, 2 * HOUR + 1740]), HOUR, 100 * HOUR).length, 3);
  });

  it("keeps today's daily candle only once the session has ended", () => {
    const rows = {
      meta: { symbol: "X", currentTradingPeriod: { regular: { start: MONDAY, end: MONDAY + 7 * HOUR } } },
      timestamp: [MONDAY - DAY, MONDAY],
      indicators: { quote: [{ open: [1, 1], high: [1, 1], low: [1, 1], close: [1, 1] }] },
    };
    assert.equal(yahooCandles(rows, DAY, MONDAY + HOUR).length, 1);
    assert.equal(yahooCandles(rows, DAY, MONDAY + 8 * HOUR).length, 2);
  });

  it("keeps yesterday's candle once today's session is on file, before today has opened", () => {
    const rows = {
      meta: { symbol: "X", currentTradingPeriod: { regular: { start: MONDAY, end: MONDAY + 7 * HOUR } } },
      timestamp: [MONDAY - 2 * DAY, MONDAY - DAY],
      indicators: { quote: [{ open: [1, 1], high: [1, 1], low: [1, 1], close: [1, 1] }] },
    };
    assert.equal(yahooCandles(rows, DAY, MONDAY - 2 * HOUR).length, 2);
  });

  it("doesn't trust last week's session for a daily row newer than it", () => {
    const rows = {
      meta: { symbol: "EURUSD=X", currentTradingPeriod: { regular: { start: MONDAY - 3 * DAY, end: MONDAY - 2 * DAY } } },
      timestamp: [MONDAY - 3 * DAY, MONDAY],
      indicators: { quote: [{ open: [1, 1], high: [1, 1], low: [1, 1], close: [1, 1] }] },
    };
    assert.equal(yahooCandles(rows, DAY, MONDAY + HOUR).length, 1);
    assert.equal(yahooCandles(rows, DAY, MONDAY + DAY).length, 2);
  });
});

describe("building timeframes", () => {
  it("counts intraday candles from the session's open, not from midnight UTC", () => {
    const hours = [0, 1, 2, 3, 4, 5, 6].map((h) => candle(MONDAY + h * HOUR, 100 + h));
    const built = resample(hours, parseTimeframe("4h"), jakarta(MONDAY + 10 * HOUR));
    assert.deepEqual(built.map((c) => c.time), [MONDAY, MONDAY + 4 * HOUR]);
    assert.equal(built[0].open, 100);
    assert.equal(built[0].close, 103);
    assert.equal(built[0].high, 104);
    assert.equal(built[0].low, 99);
    assert.equal(built[0].volume, 4000);
  });

  it("leaves out an intraday candle that hasn't closed", () => {
    const hours = [0, 1, 2, 3, 4].map((h) => candle(MONDAY + h * HOUR, 100));
    assert.equal(resample(hours, parseTimeframe("4h"), jakarta(MONDAY + 5 * HOUR)).length, 1);
  });

  it("closes a stock's week when Friday is over, and not before", () => {
    const week = [0, 1, 2, 3, 4].map((d) => candle(MONDAY + d * DAY, 100 + d));
    const weekly = parseTimeframe("1w");
    assert.equal(resample(week, weekly, jakarta(MONDAY + 4 * DAY + 2 * HOUR)).length, 0);
    const [built] = resample(week, weekly, jakarta(MONDAY + 5 * DAY));
    assert.equal(built.open, 100);
    assert.equal(built.close, 104);
    assert.equal(built.volume, 5000);
  });

  it("gives crypto its whole week", () => {
    const week = [0, 1, 2, 3, 4, 5, 6].map((d) => candle(MONDAY + d * DAY, 100));
    assert.equal(resample(week, parseTimeframe("1w"), utc(MONDAY + 5 * DAY + HOUR)).length, 0);
    assert.equal(resample(week, parseTimeframe("1w"), utc(MONDAY + 7 * DAY)).length, 1);
  });

  it("splits months in the exchange's own time", () => {
    const lastDay = Date.UTC(2026, 9, 31, 18) / 1000; // already 1 November in Jakarta
    const candles = [candle(Date.UTC(2026, 9, 1, 2) / 1000, 1), candle(lastDay, 2), candle(Date.UTC(2026, 10, 2, 2) / 1000, 3)];
    const built = resample(candles, parseTimeframe("1mo"), jakarta(Date.UTC(2026, 10, 3) / 1000));
    assert.deepEqual(built.map((c) => c.close), [1]);
  });

  it("keeps summer days in their own week and month when it's winter now", () => {
    // Yahoo stamps gold at New York's midnight: 04:00 UTC in summer. Today's offset would push these onto Sunday.
    const newYork = { timeZone: "America/New_York", utcOffset: -5 * HOUR, now: Date.UTC(2026, 10, 2) / 1000, tradingDays: 5 };
    const summer = (month: number, day: number, close: number) => candle(Date.UTC(2026, month, day, 4) / 1000, close);
    const days = [summer(4, 29, 1), summer(5, 1, 2), summer(5, 2, 3), summer(5, 8, 4)]; // Fri 29 May, Mon 1 and Tue 2 Jun, Mon 8 Jun
    assert.deepEqual(resample(days, parseTimeframe("1w"), newYork).map((c) => c.close), [1, 3, 4]);
    assert.deepEqual(resample(days, parseTimeframe("1mo"), newYork).map((c) => c.close), [1, 4]);
  });

  it("groups trading days from the newest, so every candle is whole", () => {
    assert.deepEqual(resample(days(5), parseTimeframe("2d"), utc(OLD + 10 * DAY)).map((c) => c.close), [102, 104]);
  });
});

describe("market data", () => {
  it("asks Yahoo for dated candles, because range=max quietly turns them monthly", async () => {
    market = () => yahoo(days(70));
    const series = await loadSeries("idx", "bbca", parseTimeframe("1d"), OLD + 100 * DAY);
    const url = requests[0];
    assert.match(url.pathname, /BBCA\.JK$/);
    assert.equal(url.searchParams.get("interval"), "1d");
    assert.equal(url.searchParams.get("period1"), "0");
    assert.equal(url.searchParams.get("range"), null);
    assert.equal(series.candles.length, 70);
    assert.equal(series.name, "Test Tbk");
    assert.equal(series.price, 123);
    assert.equal(series.kind, "stock");
  });

  it("doesn't pose as a browser, which Yahoo refuses", async () => {
    let headers: Headers | undefined;
    const stub = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return stub(input, init);
    }) as typeof fetch;
    market = () => yahoo(days(70));
    await loadSeries("us", "AAPL", parseTimeframe("1d"), OLD + 100 * DAY);
    globalThis.fetch = stub;
    assert.equal(headers?.get("user-agent"), null);
  });

  it("builds a timeframe Yahoo doesn't have from the next one down", async () => {
    market = () => yahoo([]);
    await loadSeries("us", "AAPL", parseTimeframe("4h"), OLD).catch(() => {});
    assert.equal(requests[0].searchParams.get("interval"), "60m");
    await loadSeries("us", "AAPL", parseTimeframe("1w"), OLD).catch(() => {});
    assert.equal(requests[1].searchParams.get("interval"), "1d");
    await loadSeries("us", "AAPL", parseTimeframe("10m"), OLD).catch(() => {});
    assert.equal(requests[2].searchParams.get("interval"), "5m");
  });

  it("writes symbols the way each market does", async () => {
    market = () => yahoo(days(70));
    const tf = parseTimeframe("1d");
    const ask = async (m: Parameters<typeof loadSeries>[0], symbol: string) => {
      await loadSeries(m, symbol, tf, OLD + 100 * DAY);
      return decodeURIComponent(requests.at(-1)!.pathname.split("/").at(-1)!);
    };
    assert.equal(await ask("idx", "IDX:TLKM"), "TLKM.JK");
    assert.equal(await ask("idx", "goto.jk"), "GOTO.JK");
    assert.equal(await ask("us", "BRK.B"), "BRK-B");
    assert.equal(await ask("us", "NASDAQ:NVDA"), "NVDA");
    assert.equal(await ask("forex", "usd/idr"), "USDIDR=X");
    assert.equal(await ask("forex", "EURUSD=X"), "EURUSD=X");
    assert.equal(await ask("other", "^JKSE"), "^JKSE");
  });

  it("refuses a forex pair that isn't one, and an empty symbol", async () => {
    await assert.rejects(loadSeries("forex", "EUR", parseTimeframe("1d")), /isn't a forex pair/);
    await assert.rejects(loadSeries("idx", " ", parseTimeframe("1d")), /Give a symbol/);
  });

  it("suggests real symbols when one doesn't exist", async () => {
    market = (url) => (url.pathname.includes("search") ? Response.json({ quotes: [{ symbol: "BBCA.JK", shortname: "Bank Central Asia", exchDisp: "Jakarta" }] }) : undefined);
    await assert.rejects(loadSeries("idx", "Bank BCA", parseTimeframe("1d")), /Did you mean: BBCA\.JK \(Bank Central Asia, Jakarta\)/);
  });

  it("still says what's wrong when the suggestions fail too", async () => {
    await assert.rejects(loadSeries("us", "NOPE", parseTimeframe("1d")), /No market data for "NOPE"\.$/);
  });

  it("explains a rate limit instead of trying to dodge it", async () => {
    market = () => new Response("Too Many Requests", { status: 429 });
    await assert.rejects(loadSeries("us", "AAPL", parseTimeframe("1d")), /try again in a few minutes/);
    assert.equal(requests.length, 1);
  });

  it("reads crypto from Binance, dropping the candle still forming", async () => {
    const hours = Array.from({ length: 80 }, (_, i) => candle(OLD + i * HOUR, 100 + i));
    market = () => Response.json(hours.map((c) => kline(c, HOUR)));
    const series = await loadSeries("crypto", "btc", parseTimeframe("1h"), OLD + 79 * HOUR + 60);
    assert.equal(requests[0].searchParams.get("symbol"), "BTCUSDT");
    assert.equal(requests[0].searchParams.get("interval"), "1h");
    assert.equal(series.candles.length, 79);
    assert.equal(series.price, 179);
    assert.equal(series.source, "Binance");
  });

  it("gives a coin on Yahoo its whole week", async () => {
    const week = [0, 1, 2, 3, 4, 5, 6].map((d) => candle(MONDAY + d * DAY, 100 + d));
    market = () => yahoo(week, { instrumentType: "CRYPTOCURRENCY", exchangeTimezoneName: "UTC", gmtoffset: 0 });
    const asked = async (now: number) => (await loadSeries("other", "BTC-USD", parseTimeframe("1w"), now)).candles.length;
    assert.equal(await asked(MONDAY + 6 * DAY), 0);
    assert.equal(await asked(MONDAY + 8 * DAY), 1);
  });

  it("builds long Binance days from days, not from weeks", async () => {
    const asked = days(300);
    market = () => Response.json(asked.map((c) => kline(c, DAY)));
    const series = await loadSeries("crypto", "BTC", parseTimeframe("14d"), OLD + 400 * DAY);
    assert.equal(requests[0].searchParams.get("interval"), "1d");
    assert.equal(series.candles.length, 21);
    assert.equal(series.candles[1].time - series.candles[0].time, 14 * DAY);
  });

  it("names a cross pair by what it's really priced in", async () => {
    market = (url) => (url.searchParams.get("symbol") === "ETHBTC" ? Response.json(days(70).map((c) => kline(c, DAY))) : new Response("{}", { status: 400 }));
    const series = await loadSeries("crypto", "ETH/BTC", parseTimeframe("1d"), OLD + 100 * DAY);
    assert.equal(series.name, "ETH / BTC");
    assert.equal(series.currency, "BTC");
  });

  it("doesn't read a coin that ends in USD as a different coin", async () => {
    market = (url) => (url.searchParams.get("symbol") === "TUSDUSDT" ? Response.json(days(70).map((c) => kline(c, DAY))) : new Response("{}", { status: 400 }));
    assert.equal((await loadSeries("crypto", "TUSD", parseTimeframe("1d"), OLD + 100 * DAY)).symbol, "TUSDUSDT");
  });

  it("names a pair in any quote it recognises, and never leaves half a name", async () => {
    market = (url) => (["BTCEUR", "ABCXYZ"].includes(url.searchParams.get("symbol") ?? "") ? Response.json(days(70).map((c) => kline(c, DAY))) : new Response("{}", { status: 400 }));
    const euro = await loadSeries("crypto", "BTCEUR", parseTimeframe("1d"), OLD + 100 * DAY);
    assert.equal(euro.name, "BTC / EUR");
    assert.equal(euro.currency, "EUR");
    assert.equal((await loadSeries("crypto", "ABCXYZ", parseTimeframe("1d"), OLD + 100 * DAY)).name, "ABCXYZ");
  });

  it("treats GUSD as a coin, not as G in dollars", async () => {
    market = (url) => (url.hostname.includes("yahoo") ? yahoo(days(70), { instrumentType: "CRYPTOCURRENCY" }) : new Response("{}", { status: 400 }));
    await loadSeries("crypto", "GUSD", parseTimeframe("1d"), OLD + 100 * DAY);
    assert.ok(!requests.some((url) => url.searchParams.get("symbol") === "GUSDT"));
    assert.match(requests.at(-1)!.pathname, /GUSD-USD$/);
  });

  it("says so plainly when a provider sends something unreadable", async () => {
    market = () => new Response("<html>blocked</html>");
    await assert.rejects(loadSeries("us", "AAPL", parseTimeframe("1d")), /sent something unreadable/);
    market = () => Response.json({ message: "busy" });
    await assert.rejects(loadSeries("crypto", "BTC", parseTimeframe("1d")), /sent something unreadable/);
  });

  it("understands the usual ways to write a pair", async () => {
    market = (url) => (url.searchParams.get("symbol") === "ETHUSDT" ? Response.json(days(70).map((c) => kline(c, DAY))) : new Response("{}", { status: 400 }));
    for (const written of ["ETH", "ETHUSDT", "ETH/USDT", "ETH-USD"]) {
      await loadSeries("crypto", written, parseTimeframe("1d"), OLD + 100 * DAY);
      assert.equal(requests.at(-1)!.searchParams.get("symbol"), "ETHUSDT");
    }
  });

  it("pages back through Binance's history", async () => {
    const hours = Array.from({ length: 1500 }, (_, i) => candle(OLD + i * HOUR, 100));
    market = (url) => {
      const end = Number(url.searchParams.get("endTime") ?? Infinity);
      return Response.json(hours.filter((c) => c.time * 1000 <= end).slice(-1000).map((c) => kline(c, HOUR)));
    };
    const series = await loadSeries("crypto", "BTC", parseTimeframe("1h"), OLD + 2000 * HOUR);
    assert.equal(requests.length, 2);
    assert.equal(series.candles.length, 1500);
    assert.deepEqual(series.candles.map((c) => c.time), hours.map((c) => c.time));
  });

  it("falls from Binance spot to futures to Yahoo for a coin it can't find", async () => {
    const listed = (host: string) => (url: URL) => {
      if (url.hostname === host) return host.includes("yahoo") ? yahoo(days(70), { instrumentType: "CRYPTOCURRENCY" }) : Response.json(days(70).map((c) => kline(c, DAY)));
      return new Response(JSON.stringify({ code: -1121 }), { status: 400 });
    };
    market = listed("fapi.binance.com");
    const futures = await loadSeries("crypto", "NEW", parseTimeframe("1d"), OLD + 100 * DAY);
    assert.equal(futures.source, "Binance futures");
    assert.equal(futures.name, "NEW / USDT perpetual");
    market = listed("query1.finance.yahoo.com");
    const series = await loadSeries("crypto", "NEW", parseTimeframe("1d"), OLD + 100 * DAY);
    assert.equal(series.kind, "crypto");
    assert.match(requests.at(-1)!.pathname, /NEW-USD$/);
  });

  it("reads gold from XAUUSDT intraday and COMEX futures from daily up", async () => {
    market = (url) => (url.hostname.includes("binance") ? Response.json(days(70).map((c) => kline(c, HOUR))) : yahoo(days(70)));
    const intraday = await loadSeries("gold", undefined, parseTimeframe("1h"), OLD + 100 * DAY);
    assert.equal(requests.at(-1)!.searchParams.get("symbol"), "XAUUSDT");
    assert.equal(intraday.kind, "gold");
    const daily = await loadSeries("gold", undefined, parseTimeframe("1d"), OLD + 100 * DAY);
    assert.match(decodeURIComponent(requests.at(-1)!.pathname), /GC=F$/);
    assert.equal(daily.kind, "gold");
  });

  it("treats XAUUSD asked as forex as gold, and survives Binance being down", async () => {
    market = (url) => (url.hostname.includes("binance") ? new Response("", { status: 500 }) : yahoo(days(70)));
    const series = await loadSeries("forex", "XAU/USD", parseTimeframe("1h"), OLD + 100 * DAY);
    assert.match(series.name, /COMEX/);
  });
});

describe("how a trade ends", () => {
  const c = (open: number, high: number, low: number, close: number) => ({ time: 0, open, high, low, close, volume: 0 });

  it("reaches the target", () => {
    assert.deepEqual(exitOf([c(100, 105, 99, 104), c(104, 111, 103, 110)], 0, 1, 95, 110), { index: 1, price: 110 });
  });

  it("assumes the stop came first when one candle touches both", () => {
    assert.deepEqual(exitOf([c(100, 111, 94, 100)], 0, 1, 95, 110), { index: 0, price: 95 });
  });

  it("fills at the open when a gap jumps past the stop", () => {
    assert.deepEqual(exitOf([c(100, 101, 99, 100), c(90, 92, 88, 91)], 0, 1, 95, 110), { index: 1, price: 90 });
  });

  it("fills at the open when a gap jumps past the target", () => {
    assert.deepEqual(exitOf([c(100, 101, 99, 100), c(120, 121, 119, 120)], 0, 1, 95, 110), { index: 1, price: 120 });
    assert.deepEqual(exitOf([c(120, 121, 119, 120)], 0, 1, 95, 110), { index: 0, price: 120 });
  });

  it("ignores the open of the candle a stop order fills in: there's no position yet", () => {
    assert.deepEqual(exitOf([c(90, 105, 94, 100), c(100, 111, 99, 110)], 0, 1, 95, 110, false), { index: 0, price: 95 });
    assert.deepEqual(exitOf([c(90, 105, 96, 100), c(100, 111, 99, 110)], 0, 1, 95, 110, false), { index: 1, price: 110 });
    assert.deepEqual(exitOf([c(120, 121, 119, 120)], 0, 1, 95, 110), { index: 0, price: 120 });
  });

  it("mirrors everything for a short", () => {
    assert.deepEqual(exitOf([c(100, 101, 99, 100), c(100, 100, 89, 90)], 0, -1, 105, 90), { index: 1, price: 90 });
    assert.deepEqual(exitOf([c(100, 106, 99, 100)], 0, -1, 105, 90), { index: 0, price: 105 });
  });

  it("leaves at the close when neither level comes in time", () => {
    const quiet = Array.from({ length: HOLD + 5 }, () => c(100, 101, 99, 100.5));
    assert.deepEqual(exitOf(quiet, 0, 1, 95, 110), { index: HOLD - 1, price: 100.5 });
  });
});

describe("measuring a rule", () => {
  const full = walk(3000);
  const part = full.slice(0, 2000);
  const COST = 0.1;

  it("decides each candle without seeing later ones", () => {
    const [a, b] = [study(part), study(full)];
    for (let i = 1; i < part.length - 1; i++) {
      assert.equal(confluenceAt(a, i), confluenceAt(b, i), `confluence at ${i}`);
      for (const side of [1, -1] as const) assert.deepEqual(breakoutEntry(a, i, side), breakoutEntry(b, i, side), `breakout at ${i}`);
    }
  });

  it("isn't swayed by later volume", () => {
    const quiet = walk(300).map((c) => ({ ...c, volume: 0 }));
    const [a, b] = [study(quiet), study([...quiet, ...walk(300)])];
    assert.deepEqual(a.hasVolume, b.hasVolume.slice(0, 300));
  });

  it("gets the same trades whatever came after them", () => {
    for (const rule of [confluenceEntry, breakoutEntry]) {
      const earlier = backtest(study(part), rule, 1, COST, 2);
      assert.ok(earlier.length > 3);
      assert.deepEqual(backtest(study(full), rule, 1, COST, 2).slice(0, earlier.length), earlier);
    }
  });

  it("charges costs on every trade", () => {
    const s = study(full);
    const free = backtest(s, breakoutEntry, 1, 0, 2);
    const paid = backtest(s, breakoutEntry, 1, 1, 2);
    assert.ok(free.length > 5);
    free.forEach((trade, i) => assert.ok(paid[i].result < trade.result));
  });

  it("can open the next trade at the close of the candle the last one ended on", () => {
    const trades = backtest(study(walk(3000, 9)), breakoutEntry, 1, COST, 2);
    assert.ok(trades.every((trade, i) => !i || trade.index >= trades[i - 1].end));
    assert.ok(trades.some((trade, i) => i && trade.index === trades[i - 1].end));
  });

  it("replays each target as its own run of trades", () => {
    const s = study(walk(3000, 9));
    assert.notEqual(backtest(s, breakoutEntry, 1, COST, 1).length, backtest(s, breakoutEntry, 1, COST, 3).length);
  });

  describe("a stop order at the break level", () => {
    // Sliding gently, so no earlier order ever fills and the one under test rests at the high of five candles ago.
    const slide = Array.from({ length: 280 }, (_, i) => candle(OLD + i * DAY, 100 - i * 0.01, { high: 101 - i * 0.01, low: 99 - i * 0.01 }));
    const level = slide[275].high;
    const next = (over: Partial<Candle>) => candle(OLD + 280 * DAY, level, { open: level - 1, high: level + 1, low: level - 1, ...over });
    const quiet = Array.from({ length: 40 }, (_, i) => candle(OLD + (281 + i) * DAY, level, { high: level + 0.5, low: level - 0.5 }));
    const series = (over: Partial<Candle>) => study([...slide, next(over), ...quiet]);

    it("fills at the level, the entry a plan prints", () => {
      assert.deepEqual(breakoutEntry(series({}), 279, 1), { planned: level, fill: level });
    });

    it("doesn't fill when price never gets there", () => {
      assert.equal(breakoutEntry(series({ high: level - 0.1 }), 279, 1), undefined);
    });

    it("fills at the open when a gap jumps past it", () => {
      assert.deepEqual(breakoutEntry(series({ open: level + 2, high: level + 3 }), 279, 1), { planned: level, fill: level + 2 });
    });

    it("keeps the printed stop and targets after a gap, so the gap's cost shows in the result", () => {
      const clean = series({});
      const gapped = series({ open: level + 2, high: level + 2.5 });
      assert.equal(stopFor(clean, 279, 1, level).stop, stopFor(gapped, 279, 1, level).stop);
      const result = (s: typeof clean) => backtest(s, breakoutEntry, 1, 0, 3).find((trade) => trade.index === 279)!.result;
      assert.ok(result(gapped) < result(clean));
    });
  });

  it("finds no rule that beats a random walk by more than chance", () => {
    const s = study(walk(3000, 21));
    const results = backtest(s, breakoutEntry, 1, 0.1, 2).map((trade) => trade.result);
    assert.ok(results.length >= 30);
    assert.equal(hasEdge(results, 0), false);
  });

  it("gives a small sample a wide range", () => {
    const large = oddsOf([...new Array(50).fill(1), ...new Array(50).fill(-1)]);
    assert.equal(large.probability, 0.5);
    assert.equal(large.low.toFixed(3), "0.404");
    assert.equal(large.high.toFixed(3), "0.596");
    const small = oddsOf([1, -1, 1, -1]);
    assert.ok(small.high - small.low > 0.5);
    assert.ok(oddsOf([1, 1, 1]).high <= 1);
  });

  it("calls an edge only with enough trades beating zero and random entries", () => {
    const steady = (count: number) => Array.from({ length: count }, (_, i) => (i % 3 ? 1.5 : 0.5));
    assert.equal(hasEdge(steady(30), 0), true);
    assert.equal(hasEdge(steady(29), 0), false);
    assert.equal(hasEdge(steady(30), 5), false);
    assert.equal(hasEdge(Array.from({ length: 30 }, (_, i) => (i % 2 ? 1 : -1)), 0), false);
  });
});

describe("price range", () => {
  it("holds about as often as it says, on data it hasn't seen", () => {
    const band = rangeForecast(study(walk(1500)), 5)!;
    const rate = band.hits / band.checks;
    assert.ok(band.checks > 200);
    assert.ok(rate > 0.72 && rate < 0.88, `held ${rate}`);
    assert.ok(band.low90 < band.low80 && band.low80 < band.high80 && band.high80 < band.high90);
  });

  it("stays silent on too little history", () => {
    assert.equal(rangeForecast(study(walk(60)), 5), undefined);
  });
});

describe("reading the chart", () => {
  it("puts supports below the price and resistances above", () => {
    const s = study(walk(500));
    const last = s.candles.length - 1;
    const { supports, resistances } = levelsAt(s, last);
    assert.ok(supports.length > 0 && supports.length <= 3);
    assert.ok(resistances.length > 0 && resistances.length <= 3);
    supports.forEach((level) => assert.ok(level.price < s.closes[last]));
    resistances.forEach((level) => assert.ok(level.price > s.closes[last]));
  });

  it("counts swings at the same price as touches", () => {
    const zigzag = Array.from({ length: 100 }, (_, i) => candle(i, i % 10 === 5 ? 120 : 100, i % 10 === 5 ? { high: 125 } : { low: 95 }));
    const s = study(zigzag);
    const { resistances } = levelsAt(s, 98);
    assert.equal(resistances[0].price, 125);
    assert.ok(resistances[0].touches >= 8);
  });

  it("counts a new candle returning to an old swing's price as a second touch", () => {
    const retest = Array.from({ length: 80 }, (_, i) => candle(OLD + i * DAY, 100, { high: i === 40 || i === 78 ? 112 : 101, low: 99 }));
    assert.deepEqual(levelsAt(study(retest), 79).resistances.find((level) => level.price === 112), { price: 112, touches: 2 });
  });

  it("doesn't count one peak twice", () => {
    const peak = Array.from({ length: 60 }, (_, i) => candle(OLD + i * DAY, 100, { high: i === 56 ? 112 : 101, low: 99 }));
    const s = study(peak);
    assert.deepEqual(levelsAt(s, 59).resistances.find((level) => level.price === 112), { price: 112, touches: 1 });
  });

  it("tells a rising market from a falling one", () => {
    const rising = study(days(260));
    assert.equal(trendAt(rising, 259).direction, "up");
    const falling = study(days(260).map((c, i) => candle(c.time, 1000 - i)));
    assert.equal(trendAt(falling, 259).direction, "down");
  });

  it("rounds to IDX price steps, and leaves other markets their decimals", () => {
    const idx = seriesOf(days(1), "BBCA.JK");
    const us = seriesOf(days(1));
    assert.equal(roundPrice(123.4, idx), 123);
    assert.equal(roundPrice(333, idx), 334);
    assert.equal(roundPrice(1233, idx), 1235);
    assert.equal(roundPrice(4987, idx), 4990);
    assert.equal(roundPrice(5012, idx), 5000);
    assert.equal(roundPrice(78055.8512, us), 78055.85);
    assert.equal(roundPrice(1.1165749, us), 1.11657);
    assert.equal(roundPrice(0.000004831234, us), 0.00000483123);
  });
});

describe("the plan", () => {
  const candles = walk(800);

  it("refuses to read too few candles", () => {
    assert.throws(() => analysed(walk(40)), /too few to analyse/);
  });

  it("waits with two scenarios when nothing is proven", () => {
    const a = analysed(candles);
    assert.equal(a.status, "WAIT");
    assert.deepEqual(a.plans.map((plan) => plan.side), [1, -1]);
    assert.ok(a.plans.every((plan) => plan.trigger !== undefined && plan.setup === "breakout"));
  });

  it("orders every level the way a trade needs them", () => {
    const [long, short] = analysed(candles).plans;
    assert.ok(long.stop < long.entry && long.entry < long.targets[0] && long.targets[0] < long.targets[1] && long.targets[1] < long.targets[2]);
    assert.ok(short.stop > short.entry && short.entry > short.targets[0] && short.targets[0] > short.targets[1] && short.targets[1] > short.targets[2]);
    assert.ok(Math.abs(long.targets[1] - (long.entry + 2 * long.risk)) < 1);
    assert.ok(long.entry > candles.at(-1)!.close && short.entry < candles.at(-1)!.close);
  });

  it("measures each scenario on its own side, and compares it with random entries", () => {
    const [long, short] = analysed(candles).plans;
    assert.equal(long.odds.length, 3);
    assert.ok(long.odds[0].trades > 0 && short.odds[0].trades > 0);
    assert.notEqual(long.odds[0].trades, short.odds[0].trades);
    assert.ok(long.random[0].trades > long.odds[0].trades);
    assert.ok(long.odds[0].reached > long.odds[2].reached, "farther targets are reached less often");
    long.odds.forEach((odds) => assert.ok(odds.probability >= odds.reached - 0.05, "leaving at the time limit can still be a profit"));
  });

  it("measures Indonesian stocks on the longs they can really take", () => {
    const a = analysed(walk(1500, 3), "TEST.JK");
    assert.equal(a.plans[0].odds[1].trades, backtest(a.s, breakoutEntry, 1, 0.45, 2).length);
  });

  it("gives Indonesian stocks no short plan", () => {
    const a = analysed(candles, "TEST.JK");
    assert.deepEqual(a.plans.map((plan) => plan.side), [1]);
    assert.ok(a.plans[0].entry % 1 === 0);
  });

  it("says avoid when an Indonesian stock turns down, since it can't be shorted", () => {
    const long = walk(1500, 3);
    const s = study(long);
    const index = s.candles.findIndex((_, i) => i > 300 && confluenceAt(s, i) < 0);
    assert.ok(index > 0);
    assert.equal(analysed(long.slice(0, index + 1), "TEST.JK").status, "AVOID");
    assert.equal(analysed(long.slice(0, index + 1)).status, "WAIT");
    assert.equal(analysed(long.slice(0, index + 2), "TEST.JK").status, "WAIT", "the signal is one candle old");
  });

  describe("with a setup that really works", () => {
    // A market that climbs in steps: every pullback ends in a rise far past 2R, so the signal's record is excellent.
    const stairs: Candle[] = [];
    let price = 100;
    for (let i = 0; i < 3000; i++) {
      const open = price;
      price *= i % 50 < 40 ? 1.012 : 0.985;
      stairs.push({ time: OLD + i * DAY, open, high: Math.max(open, price) * 1.001, low: Math.min(open, price) * 0.999, close: price, volume: 1000 });
    }
    const s = study(stairs);
    const lastSignal = s.candles.findLastIndex((_, i) => i < 2900 && confluenceAt(s, i) > 0);
    const signalled = stairs.slice(0, lastSignal + 1);

    it("calls a trade ready, as one live plan", () => {
      const a = analysed(signalled);
      assert.equal(analysed(stairs.slice(0, lastSignal + 2)).status, "WAIT", "a signal is only live on the candle it forms");
      assert.equal(a.status, "READY_LONG");
      assert.equal(a.plans.length, 1);
      assert.equal(a.plans[0].trigger, undefined);
      assert.equal(a.plans[0].setup, "confluence");
      assert.equal(a.plans[0].entry, roundPrice(signalled.at(-1)!.close, seriesOf(signalled)));
      assert.equal(a.plans[0].edge, true);
      assert.match(svgOf(a), /SIAP LONG/);
      assert.match(reportOf(a), /Status: READY LONG/);
    });

    it("never claims that below daily candles, where it didn't hold up in testing", () => {
      const a = analyze(seriesOf(signalled), parseTimeframe("4h"), signalled.at(-1)!.time + DAY);
      assert.equal(a.status, "WAIT");
      assert.ok(a.plans.every((plan) => !plan.edge));
      assert.match(reportOf(a), /below daily candles these signals lost money/);
    });
  });

  const untraded = (count: number) => Array.from({ length: count }, (_, i) => candle(OLD + (300 + i) * DAY, 500, { high: 500, low: 500, volume: 0 }));

  describe("on wild long-term charts", () => {
    const wild = Array.from({ length: 300 }, (_, i) => candle(OLD + i * DAY, 10 + (i % 2) * 4, { high: 15, low: 8 }));

    it("never prints a target below zero", () => {
      const a = analysed(wild);
      assert.ok(a.plans.flatMap((plan) => plan.targets).every((price) => price > 0));
      const short = a.plans.find((plan) => plan.side < 0);
      if (short) {
        assert.ok(short.targets.length < 3);
        assert.equal(short.odds.length, short.targets.length);
        assert.match(reportOf(a), /Targets past zero are left out/);
      }
      assert.doesNotMatch(reportOf(a), /TP\d -/);
      assert.doesNotMatch(svgOf(a), /NaN|undefined/);
    });

    it("never prints a stop below zero", () => {
      const s = study(wild);
      assert.ok(stopFor(s, 299, 1, 5).stop > 0);
    });
  });

  it("prices plans and backtests through the same levels, price steps included", () => {
    const a = analysed(walk(800), "TEST.JK");
    const [plan] = a.plans;
    const levels = levelsOf(a.s, a.s.candles.length - 1, 1, plan.entry)!;
    assert.deepEqual({ entry: plan.entry, stop: plan.stop, targets: plan.targets }, { entry: levels.entry, stop: levels.stop, targets: levels.targets });
    const tick = (price: number) => (price < 200 ? 1 : price < 500 ? 2 : price < 2000 ? 5 : price < 5000 ? 10 : 25);
    for (const price of [plan.entry, plan.stop, ...plan.targets]) assert.equal(price % tick(price), 0, `${price} isn't a valid price`);
  });

  it("keeps targets apart where the price step changes", () => {
    const flat = walk(300).map((c, i) => candle(c.time, 4985 + (i % 2) * 2, { high: 4990, low: 4980 }));
    const s = study(flat, analysed(flat, "TEST.JK").s.pricing);
    const levels = levelsOf(s, 299, 1, 4990)!;
    levels.targets.forEach((target, i) => assert.ok(target > (i ? levels.targets[i - 1] : levels.entry), levels.targets.join()));
  });

  it("says when price has already gone past a scenario's entry", () => {
    const candles = walk(800);
    const quiet = analysed(candles);
    assert.ok(quiet.plans.every((plan) => !plan.passed));
    const series = { ...seriesOf(candles), price: quiet.plans[0].entry + 1 };
    const a = analyze(series, parseTimeframe("1d"), candles.at(-1)!.time + DAY);
    assert.equal(a.plans[0].passed, true);
    assert.equal(a.plans[1].passed, false);
    assert.match(reportOf(a), /already past this entry/);
    assert.match(svgOf(a), /sudah lewat level ini/);
  });

  it("isn't fooled into a fresh signal when volume starts appearing", () => {
    const rising = Array.from({ length: 450 }, (_, i) => {
      const close = 100 * 1.01 ** i;
      return candle(OLD + i * DAY, close, { open: close * 0.99, high: close * 1.001, low: close * 0.985, volume: i < 350 ? 0 : 1000 });
    });
    const s = study(rising);
    const flip = s.hasVolume.indexOf(true, 300);
    assert.equal(s.hasVolume[flip - 1], false);
    assert.equal(confluenceAt(s, flip), 0, "every indicator already agreed on the candle before");
  });

  it("has no volume line when the average is zero", () => {
    const empty = [...walk(300), ...walk(30, 3).map((c, i) => ({ ...c, time: OLD + (300 + i) * DAY, volume: 0 }))];
    assert.doesNotMatch(reportOf(analysed(empty)), /NaN|Infinity/);
  });

  it("keeps a forced stop on the price step of the side it's on", () => {
    const flatAt = (price: number) => walk(300).map((c, i) => candle(c.time, price + (i % 2) * 0.05, { high: price + 0.1, low: price - 0.1 }));
    assert.equal(analysed(flatAt(500), "TEST.JK").plans[0].stop, 498);
    assert.equal(analysed(flatAt(5000), "TEST.JK").plans[0].stop, 4990);
  });

  it("drops a level that rounds onto the close", () => {
    const a = analysed(walk(800), "TEST.JK");
    const close = a.s.closes.at(-1)!;
    assert.ok(a.levels.supports.every((level) => level.price < close));
    assert.ok(a.levels.resistances.every((level) => level.price > close));
  });

  it("doesn't call quiet forex suspended", () => {
    const still = walk(300).map((c, i) => (i > 270 ? candle(c.time, 18000, { high: 18000, low: 18000, volume: 0 }) : { ...c, volume: 0 }));
    const a = analyze({ ...seriesOf(still, "USDIDR=X", "forex") }, parseTimeframe("15m"), OLD + 400 * DAY);
    assert.equal(a.status, "WAIT");
  });

  it("sees volume that only started recently", () => {
    const empty = walk(300).map((c) => ({ ...c, volume: 0 }));
    const s = study([...empty, ...walk(100, 3).map((c, i) => ({ ...c, time: OLD + (300 + i) * DAY }))]);
    assert.equal(s.hasVolume.at(-1), true);
    assert.equal(s.hasVolume[200], false);
  });

  it("warns about a market that barely trades", () => {
    assert.match(analysed([...walk(300), ...untraded(12)]).warnings.join(), /illiquid/);
  });

  it("gives no plan for a stock that has stopped trading", () => {
    assert.throws(() => analysed([...walk(300), ...untraded(20)]), /probably suspended/);
  });

  it("doesn't mistake flat candles in an active market for a halt", () => {
    const active = walk(300).map((c, i) => (i > 280 ? { ...c, high: c.close, low: c.close, open: c.close } : c));
    assert.doesNotMatch(analysed(active).warnings.join(), /illiquid/);
  });

  it("keeps a stop at least one price step from the entry", () => {
    const quiet = walk(300).map((c, i) => candle(c.time, 100 + (i % 2) * 0.2, { high: 100.3, low: 99.9 }));
    const [plan] = analysed(quiet, "TEST.JK").plans;
    assert.ok(plan.risk >= 1, `risk ${plan.risk}`);
  });

  it("warns that short timeframes cost the most", () => {
    const a = analyze(seriesOf(walk(300)), parseTimeframe("5m"), OLD + 400 * DAY);
    assert.match(a.warnings.join(), /Short timeframes/);
  });

  it("copes with a young instrument", () => {
    const a = analysed(walk(100));
    assert.equal(a.band, undefined);
    assert.match(a.warnings.join(), /Too little history/);
    assert.match(reportOf(a), /Range: not enough history/);
    assert.deepEqual(reportOf(a).match(/.{0,60}NaN.{0,20}/g), null);
    assert.deepEqual(svgOf(a).match(/.{0,60}NaN.{0,20}/g), null);
  });

  it("includes the bigger picture when it's available", () => {
    const a = analyze(seriesOf(candles), parseTimeframe("1d"), OLD + 900 * DAY, { series: seriesOf(walk(300, 5)), tf: parseTimeframe("1w") });
    assert.equal(a.higher?.tf.label, "1w");
    assert.match(reportOf(a), /1w trend: /);
  });
});

describe("what Friday is told", () => {
  const a = analysed(walk(2500));
  const ready: Analysis = { ...a, status: "READY_LONG", signal: 1, plans: [{ ...a.plans[0], setup: "confluence", trigger: undefined, edge: true }] };

  it("carries every number a follow-up question needs", () => {
    const report = reportOf(a);
    const plan = a.plans[0];
    for (const value of [plan.entry, plan.stop, ...plan.targets]) assert.ok(report.includes(String(value)), `${value} is missing`);
    assert.match(report, /Status: WAIT/);
    assert.match(report, /TP1: \d+ past cases, reached \d+%, ended in profit \d+%/);
    assert.match(report, /like a stop order resting there/);
    assert.match(report, /random entries reached \d+%, ended in profit \d+%/);
    assert.match(report, /per unit/);
    assert.match(report, /Follow-up questions/);
    assert.match(report, /Last closed candles/);
  });

  it("never lets a chance read as a promise", () => {
    const report = reportOf(a);
    assert.match(report, /not a forecast/);
    assert.match(report, /never say a trade will win/);
    assert.match(report, /isn't investment advice/);
    assert.match(report, /licensed adviser/);
    assert.match(report, /No measured edge/);
  });

  it("doesn't choose how much of someone's money to risk", () => {
    assert.match(reportOf(a), /how much to risk is their decision/);
  });

  it("keeps tiny MACD values readable at tiny prices", () => {
    const tiny = walk(800, 7, 0.00001);
    assert.doesNotMatch(reportOf(analysed(tiny)), /MACD histogram (-)?0 /);
  });

  it("gives risk per lot for Indonesian stocks", () => {
    assert.match(reportOf(analysed(walk(800), "TEST.JK")), /per share, [\d.]+ per lot of 100/);
  });

  it("warns that a ready plan's figures were picked for being high", () => {
    assert.match(reportOf(ready), /expect less than they show/);
  });

  it("says when a plan is live rather than conditional", () => {
    const report = reportOf(ready);
    assert.match(report, /Status: READY LONG/);
    assert.match(report, /Plan: Long now/);
    assert.match(report, /beat random entries by more than chance/);
  });
});

describe("the chart", () => {
  const a = analysed(walk(800));

  it("is a tall PNG for reading on a phone", async () => {
    const { format, width, height } = await sharp(await chartOf(a)).metadata();
    assert.equal(format, "png");
    assert.equal(width, 1080);
    assert.ok(height! > width!);
  });

  it("has the analysis drawn on it", () => {
    const svg = svgOf(a);
    for (const mark of ["TUNGGU", "TP1", "TP2", "SL", "80%", "Rentang", "Kena TP", "Profit", "Bukan saran investasi", "EMA200"]) assert.ok(svg.includes(mark), mark);
    assert.match(svg, /[RS] [\d.,]+ \(\d+x\)/);
    assert.match(svg, /[HL][HL]</);
  });

  it("marks a figure from random entries when past cases are too few", () => {
    const thin = { ...a, plans: a.plans.map((plan) => ({ ...plan, odds: plan.odds.map((odds) => ({ ...odds, trades: 12 })) })) };
    assert.match(svgOf(thin), />~\d+%</);
    assert.match(svgOf(thin), /baru 12 kasus/);
  });

  it("zooms in when older moves would squash the plan", () => {
    const fall = Array.from({ length: 300 }, (_, i) => candle(OLD + i * DAY, 1100 + (300 - i) * 10, { high: 1110 + (300 - i) * 10, low: 1090 + (300 - i) * 10 }));
    const calm = Array.from({ length: 40 }, (_, i) => candle(OLD + (300 + i) * DAY, 1100 + (i % 3), { high: 1102 + (i % 3), low: 1098 + (i % 3) }));
    const crash = [...fall, ...calm];
    const bars = (svg: string) => svg.match(/fill-opacity="0\.6"/g)?.length;
    assert.ok(bars(svgOf(analysed(crash)))! < bars(svgOf(a))!);
  });

  it("escapes names, which come from outside", () => {
    const named = { ...a, series: { ...a.series, name: `A&B <"Corp">` } };
    assert.match(svgOf(named), /A&amp;B &lt;&quot;Corp&quot;&gt;/);
  });
});

describe("the market_analysis tool", () => {
  type Sent = { chatId: string; text?: string; image?: Buffer };
  let sent: Sent[] = [];
  const outbox: Outbox = {
    async sendText(chatId, text) {
      sent.push({ chatId, text });
    },
    async sendFile() {},
    async sendImage(chatId, image) {
      sent.push({ chatId, image: image.data });
    },
    async typing() {},
    chatIdFor: (n) => `${n}@s.whatsapp.net`,
  };
  const chat = (isContact: boolean) => ({ chatId: "chat-1", isGroup: false, chatName: "Budi", sender: { name: "Budi", number: "6281000000000", isContact } });
  const input = { market: "us", symbol: "AAPL", timeframe: "1d" };

  beforeEach(() => {
    sent = [];
    market = () => yahoo(walk(800));
  });

  it("is offered to Claude", () => {
    assert.ok(toolParams.some((t) => "name" in t && t.name === "market_analysis"));
  });

  it("is only for contacts", async () => {
    const result = await runTool("market_analysis", input, { chat: chat(false), outbox });
    assert.equal(result.isError, true);
    assert.match(result.content, /Only known contacts/);
    assert.equal(requests.length, 0);
  });

  it("sends the chart and hands Claude the numbers", async () => {
    const result = await runTool("market_analysis", input, { chat: chat(true), outbox });
    assert.equal(result.isError, false);
    assert.match(result.content, /^Chart sent as image #\d+/);
    assert.match(result.content, /MARKET ANALYSIS of Test Tbk/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, "chat-1");
    assert.ok(sent[0].image!.length > 1000);
  });

  it("still gives the analysis when the chart can't be sent", async () => {
    const broken: Outbox = { ...outbox, sendImage: () => Promise.reject(new Error("no")) };
    const result = await runTool("market_analysis", input, { chat: chat(true), outbox: broken });
    assert.equal(result.isError, false);
    assert.match(result.content, /couldn't be sent/);
    assert.match(result.content, /MARKET ANALYSIS/);
  });

  it("passes a data problem on as a readable error", async () => {
    market = () => new Response("", { status: 429 });
    const result = await runTool("market_analysis", input, { chat: chat(true), outbox });
    assert.equal(result.isError, true);
    assert.match(result.content, /try again in a few minutes/);
  });

  it("keeps working when the bigger timeframe fails", async () => {
    market = (url) => (url.searchParams.get("interval") === "1d" && requests.length > 1 ? new Response("", { status: 500 }) : yahoo(walk(800)));
    const result = await runTool("market_analysis", input, { chat: chat(true), outbox });
    assert.equal(result.isError, false);
  });

  it("leaves its numbers in the conversation for follow-up questions", async () => {
    const dm = (text: string): Incoming => ({
      chat: { chatId: `${ADMIN.number}@s.whatsapp.net`, isGroup: false, chatName: ADMIN.name, sender: { ...ADMIN, isContact: true } },
      text,
      addressed: true,
    });
    claude.replies.push(
      { content: [{ type: "tool_use", id: "t1", name: "market_analysis", input }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Status: tunggu." }], stop_reason: "end_turn" },
      { content: [{ type: "text", text: "Karena di bawah swing low." }], stop_reason: "end_turn" },
    );
    await handleIncoming(dm("analisis AAPL harian"), outbox);
    await handleIncoming(dm("kenapa SL-nya di situ?"), outbox);
    const history = claude.requests.at(-1)!.body.messages.flatMap((m: { content: unknown }) => (Array.isArray(m.content) ? m.content : []));
    const report = history.find((block: { type: string }) => block.type === "tool_result");
    assert.match(String(report.content), /MARKET ANALYSIS/);
    assert.match(String(report.content), /Follow-up questions/);
    assert.ok(sent.some((message) => message.text === "Karena di bawah swing low."));
    assert.ok(sent.some((message) => message.image));
  });
});
