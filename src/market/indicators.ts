// Every value at index i uses candles up to i only, so a backtest can read these arrays without seeing the future.
// Indexes without enough history hold NaN.

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/** Smooths from the first real value, seeded with the plain average of the first `period` values. */
function smooth(values: number[], period: number, next: (previous: number, value: number) => number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const first = values.findIndex((v) => !Number.isNaN(v));
  if (first < 0 || values.length < first + period) return out;
  let average = mean(values.slice(first, first + period));
  out[first + period - 1] = average;
  for (let i = first + period; i < values.length; i++) {
    average = next(average, values[i]);
    out[i] = average;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  return smooth(values, period, (previous, value) => value * k + previous * (1 - k));
}

/** Wilder's smoothing, used by RSI, ATR and ADX. */
export function wilder(values: number[], period: number): number[] {
  return smooth(values, period, (previous, value) => (previous * (period - 1) + value) / period);
}

export function rsi(closes: number[], period = 14): number[] {
  const change = closes.map((close, i) => (i ? close - closes[i - 1] : NaN));
  const gain = wilder(change.map((c) => (Number.isNaN(c) ? c : Math.max(c, 0))), period);
  const loss = wilder(change.map((c) => (Number.isNaN(c) ? c : Math.max(-c, 0))), period);
  return gain.map((g, i) => (loss[i] === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / loss[i])));
}

const trueRange = (candles: Candle[]) =>
  candles.map((c, i) => (i ? Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)) : NaN));

export function atr(candles: Candle[], period = 14): number[] {
  return wilder(trueRange(candles), period);
}

export function adx(candles: Candle[], period = 14): { adx: number[]; plusDi: number[]; minusDi: number[] } {
  const up = candles.map((c, i) => (i ? c.high - candles[i - 1].high : NaN));
  const down = candles.map((c, i) => (i ? candles[i - 1].low - c.low : NaN));
  const plusMove = up.map((u, i) => (Number.isNaN(u) ? u : u > down[i] && u > 0 ? u : 0));
  const minusMove = down.map((d, i) => (Number.isNaN(d) ? d : d > up[i] && d > 0 ? d : 0));
  const range = wilder(trueRange(candles), period);
  const plusDi = wilder(plusMove, period).map((v, i) => (range[i] ? (100 * v) / range[i] : range[i]));
  const minusDi = wilder(minusMove, period).map((v, i) => (range[i] ? (100 * v) / range[i] : range[i]));
  const dx = plusDi.map((p, i) => (p + minusDi[i] ? (100 * Math.abs(p - minusDi[i])) / (p + minusDi[i]) : Number.isNaN(p) ? NaN : 0));
  return { adx: wilder(dx, period), plusDi, minusDi };
}

/** MACD(12, 26) minus its 9-period signal line. */
export function macdHistogram(closes: number[]): number[] {
  const slow = ema(closes, 26);
  const macd = ema(closes, 12).map((fast, i) => fast - slow[i]);
  const signal = ema(macd, 9);
  return macd.map((m, i) => m - signal[i]);
}

export function obv(candles: Candle[]): number[] {
  let total = 0;
  return candles.map((c, i) => (total += i ? Math.sign(c.close - candles[i - 1].close) * c.volume : 0));
}

/** Plain moving average; used for typical volume. */
export function sma(values: number[], period: number): number[] {
  return values.map((_, i) => (i < period - 1 ? NaN : mean(values.slice(i - period + 1, i + 1))));
}
