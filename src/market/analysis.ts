import { higherTimeframe, loadSeries, parseTimeframe, type Market, type Series, type Timeframe } from "./candles.js";
import { adx, atr, ema, macdHistogram, obv, rsi, sma, type Candle } from "./indicators.js";

// Turns candles into a trading plan and measures that plan on the instrument's own history. Tested on 32 instruments,
// classic rules didn't beat random entries, so nothing here predicts direction: a trade is only called ready when its
// own history shows a measured edge, and every plan carries how often its setup really paid, next to random entries.

export const TARGETS = [1, 2, 3]; // in multiples of the risk (R)
export const HOLD = 30; // candles a plan may stay open
export const MIN_CANDLES = 60;
const SWING = 3; // candles on each side that make a swing high or low
const LOOKBACK = 120; // how far back a swing still matters for a plan
const WARMUP = 210; // EMA200 needs this many candles before a backtest can start
export const MIN_TRADES = 30;
const MIN_MOVES = 150; // past moves a range needs before it can be trusted, or checked
const EDGE_TIMEFRAME = 86_400; // on 4h, 1h and 15m these signals lost money after costs, so no edge is claimed there
const Z = 1.96;

type Side = 1 | -1;

/** The prices an order can really use: rounding them, and the next one along. */
export type Pricing = { round: (price: number) => number; step: (price: number, side: Side) => number };

/** IDX price steps: orders at any other price are rejected. */
function idxTick(price: number): number {
  if (price < 200) return 1;
  if (price < 500) return 2;
  if (price < 2000) return 5;
  return price < 5000 ? 10 : 25;
}

const idxRound = (price: number) => Math.round(price / idxTick(price)) * idxTick(price);
const plainRound = (price: number) => Number(price >= 1000 ? price.toFixed(2) : price.toPrecision(6));

const IDX: Pricing = { round: idxRound, step: (price, side) => price + side * idxTick(side > 0 ? price : price - 1) };
const PLAIN: Pricing = {
  round: plainRound,
  step: (price, side) => plainRound(price + side * (price >= 1000 ? 0.01 : 10 ** (Math.floor(Math.log10(price)) - 5))),
};

export type Study = {
  candles: Candle[];
  pricing: Pricing;
  closes: number[];
  ema20: number[];
  ema50: number[];
  ema200: number[];
  rsi: number[];
  atr: number[];
  adx: number[];
  plusDi: number[];
  minusDi: number[];
  macd: number[];
  obv: number[];
  obvAverage: number[];
  volumeAverage: number[];
  /** Whether a candle sits among real volume, judged on recent candles so old empty years count for nothing. */
  hasVolume: boolean[];
  swingHigh: boolean[];
  swingLow: boolean[];
};

export function study(candles: Candle[], pricing = PLAIN): Study {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const onBalance = obv(candles);
  const strength = adx(candles);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const isSwing = (values: number[], side: Side) =>
    values.map((value, j) => {
      if (j < SWING || j + SWING >= values.length) return false;
      const before = values.slice(j - SWING, j).map((v) => v * side);
      const after = values.slice(j + 1, j + SWING + 1).map((v) => v * side);
      return value * side > Math.max(...before) && value * side >= Math.max(...after);
    });
  return {
    candles,
    pricing,
    closes,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi: rsi(closes),
    atr: atr(candles),
    adx: strength.adx,
    plusDi: strength.plusDi,
    minusDi: strength.minusDi,
    macd: macdHistogram(closes),
    obv: onBalance,
    obvAverage: ema(onBalance, 20),
    volumeAverage: sma(volumes, 20),
    hasVolume: volumes.map((_, i) => {
      const recent = volumes.slice(Math.max(0, i - 49), i + 1);
      return recent.filter((v) => v > 0).length >= recent.length / 2;
    }),
    swingHigh: isSwing(highs, 1),
    swingLow: isSwing(lows, -1),
  };
}

/** Swing prices known at candle i, newest first. A swing only exists once SWING candles have closed after it. */
function swingsAt(s: Study, i: number, kind: "high" | "low", lookback = LOOKBACK): number[] {
  const found: number[] = [];
  for (let j = i - SWING; j >= Math.max(SWING, i - lookback); j--) {
    if (kind === "high" ? s.swingHigh[j] : s.swingLow[j]) found.push(kind === "high" ? s.candles[j].high : s.candles[j].low);
  }
  return found;
}

/** The nearest swing price that has to break to go long (side 1) or short (side -1). */
function nextSwing(s: Study, i: number, side: Side): number | undefined {
  const beyond = swingsAt(s, i, side > 0 ? "high" : "low").filter((price) => (price - s.closes[i]) * side > 0);
  return beyond.length ? (side > 0 ? Math.min(...beyond) : Math.max(...beyond)) : undefined;
}

function votes(s: Study, i: number): number {
  return (
    Math.sign(s.closes[i] - s.ema50[i]) +
    Math.sign(s.ema50[i] - s.ema200[i]) +
    Math.sign(s.rsi[i] - 50) +
    Math.sign(s.macd[i]) +
    (s.adx[i] >= 20 ? Math.sign(s.plusDi[i] - s.minusDi[i]) : 0) +
    (s.hasVolume[i] ? Math.sign(s.obv[i] - s.obvAverage[i]) : 0)
  );
}

const allAgree = (s: Study, i: number) => Math.abs(votes(s, i)) === (s.hasVolume[i] ? 6 : 5);

/** All indicators agree, and only just started to: a move that's been running for a while is no longer a fresh entry. */
export function confluenceAt(s: Study, i: number): number {
  return allAgree(s, i) && !allAgree(s, i - 1) ? Math.sign(votes(s, i)) : 0;
}

/** The price that has to break: the nearest swing, or the last few candles' extreme when that's closer. */
function breakLevel(s: Study, i: number, side: Side): number | undefined {
  const recent = s.candles.slice(Math.max(0, i - 4), i + 1);
  const extreme = side > 0 ? Math.max(...recent.map((c) => c.high)) : Math.min(...recent.map((c) => c.low));
  const candidates = [extreme, nextSwing(s, i, side)].filter((price): price is number => price !== undefined && (price - s.closes[i]) * side > 0);
  return candidates.length ? (side > 0 ? Math.min(...candidates) : Math.max(...candidates)) : undefined;
}

/** Where a plan means to enter, which sets its stop and targets, and where it would really have filled. */
export type Entry = { planned: number; fill: number };

/** Decides at the close of candle i, knowing nothing later; only the fill comes from the next candle. */
export type Rule = (s: Study, i: number, side: Side) => Entry | undefined;

const nextOpen = (s: Study, i: number): Entry => ({ planned: s.closes[i], fill: s.candles[i + 1].open });

/** Entering at the next open when all indicators have just agreed. */
export const confluenceEntry: Rule = (s, i, side) => (confluenceAt(s, i) === side ? nextOpen(s, i) : undefined);

/** A stop order resting at the break level through the next candle, filled at the open if a gap jumps past it. */
export const breakoutEntry: Rule = (s, i, side) => {
  const broken = breakLevel(s, i, side);
  if (broken === undefined) return undefined;
  const level = s.pricing.round(broken);
  const next = s.candles[i + 1];
  if (((side > 0 ? next.high : next.low) - level) * side < 0) return undefined;
  return { planned: level, fill: side > 0 ? Math.max(level, next.open) : Math.min(level, next.open) };
};

/** Stops sit past the last swing, where the idea is proven wrong, unless that's unreasonably close or far. */
export function stopFor(s: Study, i: number, side: Side, entry: number): { stop: number; swing?: number } {
  const swing = swingsAt(s, i, side > 0 ? "low" : "high")[0];
  if (swing !== undefined) {
    const stop = swing - side * 0.25 * s.atr[i];
    const distance = (entry - stop) * side;
    if (stop > 0 && distance >= s.atr[i] && distance <= 3 * s.atr[i]) return { stop, swing };
  }
  const stop = entry - side * 1.5 * s.atr[i];
  return { stop: side > 0 ? Math.max(stop, entry / 2) : stop }; // on wild monthly charts 1.5 ATR can reach past zero
}

export type Levels = { entry: number; stop: number; swing?: number; risk: number; targets: number[] };

/** A plan's prices. Printed plans and backtests both come through here, so what's measured is what's printed. */
export function levelsOf(s: Study, i: number, side: Side, planned: number): Levels | undefined {
  const { round, step } = s.pricing;
  const entry = round(planned);
  const { stop: rawStop, swing } = stopFor(s, i, side, entry);
  // In a very quiet stock the stop can round onto the entry, and targets can round onto each other where the price
  // step changes. The next price along is then the closest they can really be.
  const stop = round(rawStop) === entry ? step(entry, side > 0 ? -1 : 1) : round(rawStop);
  const risk = (entry - stop) * side;
  if (!(risk > 0)) return undefined;
  const targets: number[] = [];
  for (const target of TARGETS) {
    const previous = targets.at(-1) ?? entry;
    const price = round(entry + side * target * risk);
    const next = (price - previous) * side > 0 ? price : step(previous, side);
    if (next > 0) targets.push(next); // a short can't fall past zero
  }
  return targets.length ? { entry, stop, swing, risk, targets } : undefined;
}

/**
 * Where a position opened during candle `start` ends. When one candle reaches both levels, the stop is assumed to come
 * first. `filledAtOpen` is false for a stop order filled later in that candle: it doesn't exist yet at the open.
 */
export function exitOf(candles: Candle[], start: number, side: Side, stop: number, goal: number, filledAtOpen = true): { index: number; price: number } {
  const last = Math.min(start + HOLD - 1, candles.length - 1);
  for (let j = start; j <= last; j++) {
    const c = candles[j];
    const held = j > start || filledAtOpen;
    if (held && ((c.open - stop) * side <= 0 || (c.open - goal) * side >= 0)) return { index: j, price: c.open }; // gapped past a level
    if (((side > 0 ? c.low : c.high) - stop) * side <= 0) return { index: j, price: stop };
    if (((side > 0 ? c.high : c.low) - goal) * side >= 0) return { index: j, price: goal };
  }
  return { index: last, price: candles[last].close };
}

export type Trade = { index: number; result: number; reached: boolean; end: number };

/**
 * One trade aiming for one target. The levels are fixed from the planned entry, exactly as a plan prints them, while
 * the result uses the real fill: a gap past the entry costs what it would cost someone following that plan. Results are
 * in multiples of the planned risk, after costs.
 */
function tradeAt(s: Study, i: number, side: Side, { planned, fill }: Entry, costPercent: number, target: number): Trade | undefined {
  const levels = levelsOf(s, i, side, planned);
  const goal = levels?.targets[TARGETS.indexOf(target)];
  if (!levels || goal === undefined) return undefined;
  const exit = exitOf(s.candles, i + 1, side, levels.stop, goal, fill === s.candles[i + 1].open);
  const gain = ((exit.price - fill) * side) / levels.risk;
  const cost = ((costPercent / 100) * fill) / levels.risk;
  return { index: i, result: gain - cost, reached: gain > 0 && (exit.price - goal) * side >= 0, end: exit.index };
}

const lastEntry = (s: Study) => s.candles.length - HOLD - 2; // later trades can't be seen through to the end

/** Replays a rule on one side, one position at a time, as a person following it would. */
export function backtest(s: Study, rule: Rule, side: Side, costPercent: number, target: number): Trade[] {
  const trades: Trade[] = [];
  for (let i = WARMUP; i <= lastEntry(s); i++) {
    const entry = rule(s, i, side);
    const trade = entry && tradeAt(s, i, side, entry, costPercent, target);
    if (!trade) continue;
    trades.push(trade);
    i = trade.end - 1; // flat again by this candle's close, so its close can already start the next trade
  }
  return trades;
}

/** Entering at every candle: what the same stop and targets earn with no signal at all. */
function randomEntries(s: Study, side: Side, costPercent: number, target: number): Trade[] {
  const trades: Trade[] = [];
  for (let i = WARMUP; i <= lastEntry(s); i++) {
    const trade = tradeAt(s, i, side, nextOpen(s, i), costPercent, target);
    if (trade) trades.push(trade);
  }
  return trades;
}

/**
 * How a plan did in the past. `reached` is how often the target came before the stop; `probability` is how often the
 * trade ended in profit, which is higher because some leave in profit at the time limit without reaching the target.
 */
export type Odds = { trades: number; reached: number; probability: number; low: number; high: number; average: number };

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/** Wilson interval: unlike the plain one it stays honest on small samples and near 0% or 100%. */
export function oddsOf(results: number[], reached = 0): Odds {
  const n = results.length;
  if (!n) return { trades: 0, reached: NaN, probability: NaN, low: NaN, high: NaN, average: NaN };
  const p = results.filter((r) => r > 0).length / n;
  const denominator = 1 + (Z * Z) / n;
  const centre = (p + (Z * Z) / (2 * n)) / denominator;
  const margin = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / denominator;
  return { trades: n, reached: reached / n, probability: p, low: Math.max(0, centre - margin), high: Math.min(1, centre + margin), average: mean(results) };
}

/** Whether the rule beat both zero and random entries by more than chance, judged at the 2R target. */
export function hasEdge(results: number[], randomAverage: number): boolean {
  if (results.length < MIN_TRADES) return false;
  const average = mean(results);
  const deviation = Math.sqrt(results.reduce((sum, r) => sum + (r - average) ** 2, 0) / (results.length - 1));
  return average - (Z * deviation) / Math.sqrt(results.length) > Math.max(0, randomAverage);
}

export type Band = { candles: number; low80: number; high80: number; low90: number; high90: number; hits: number; checks: number };

function quantile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function bandFrom(moves: number[], close: number, volatility: number) {
  const sorted = moves.slice(-500).sort((a, b) => a - b);
  const at = (p: number) => close + quantile(sorted, p) * volatility;
  return { low80: at(0.1), high80: at(0.9), low90: at(0.05), high90: at(0.95) };
}

/**
 * Where the close may be `horizon` candles from now: past moves of that length, scaled by today's volatility. Direction
 * can't be forecast, but this range can: its 80% band was right 78-80% of the time across markets. Each past check only
 * uses moves that had finished by then, and the result reports how the band did on this instrument.
 */
export function rangeForecast(s: Study, horizon: number): Band | undefined {
  const moves: number[] = [];
  const last = s.candles.length - 1;
  let hits = 0;
  let checks = 0;
  for (let i = 30; i <= last; i++) {
    const start = i - horizon;
    if (start >= 14 && s.atr[start] > 0) moves.push((s.closes[i] - s.closes[start]) / s.atr[start]);
    if (moves.length < MIN_MOVES || i + horizon > last || (i - 30) % horizon !== 0 || !(s.atr[i] > 0)) continue;
    const band = bandFrom(moves, s.closes[i], s.atr[i]);
    const close = s.closes[i + horizon];
    if (close >= band.low80 && close <= band.high80) hits++;
    checks++;
  }
  if (moves.length < MIN_MOVES || !(s.atr[last] > 0)) return undefined;
  return { candles: horizon, ...bandFrom(moves, s.closes[last], s.atr[last]), hits, checks };
}

function horizonFor(tf: Timeframe): number {
  if (tf.seconds < 3600) return 16;
  if (tf.seconds < 14_400) return 8;
  if (tf.seconds < 86_400) return 6;
  return tf.seconds < 604_800 ? 5 : 4;
}

export type Level = { price: number; touches: number };

/** Prices where swings cluster, nearest first: the closest level, then the ones touched most. */
export function levelsAt(s: Study, i: number): { supports: Level[]; resistances: Level[] } {
  const first = Math.max(0, i - 4);
  // The last few candles' extremes are too new to be confirmed swings, but a trader would mark them. One that already is
  // a swing mustn't count twice; a new candle returning to an old swing's price is a second touch, so it does count.
  const extreme = (values: number[], price: number, swing: boolean[]) => {
    const index = first + values.lastIndexOf(price);
    return index <= i - SWING && swing[index] ? [] : [price];
  };
  const highs = s.candles.slice(first, i + 1).map((c) => c.high);
  const lows = s.candles.slice(first, i + 1).map((c) => c.low);
  const prices = [
    ...swingsAt(s, i, "high", 300),
    ...swingsAt(s, i, "low", 300),
    ...extreme(highs, Math.max(...highs), s.swingHigh),
    ...extreme(lows, Math.min(...lows), s.swingLow),
  ].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const price of prices) {
    const cluster = clusters.at(-1);
    if (cluster && price - mean(cluster) <= 0.5 * s.atr[i]) cluster.push(price);
    else clusters.push([price]);
  }
  const levels = clusters.map((cluster) => ({ price: mean(cluster), touches: cluster.length }));
  const pick = (list: Level[]) => {
    const [nearest, ...others] = list;
    const ranked = [nearest, ...others.filter((level) => level.touches >= 2), ...others.filter((level) => level.touches < 2)];
    const chosen = new Set(ranked.slice(0, 3));
    return list.filter((level) => chosen.has(level));
  };
  return {
    supports: pick(levels.filter((level) => level.price < s.closes[i]).reverse()),
    resistances: pick(levels.filter((level) => level.price > s.closes[i])),
  };
}

export type Trend = { direction: "up" | "down" | "sideways"; strength: "strong" | "moderate" | "weak"; structure: string };

export function trendAt(s: Study, i: number): Trend {
  const slow = Number.isNaN(s.ema200[i]) ? s.ema50 : s.ema200; // short histories have no EMA200
  const fast = Number.isNaN(s.ema200[i]) ? s.ema20 : s.ema50;
  const direction = fast[i] > slow[i] && s.closes[i] > fast[i] ? "up" : fast[i] < slow[i] && s.closes[i] < fast[i] ? "down" : "sideways";
  const [high, previousHigh] = swingsAt(s, i, "high");
  const [low, previousLow] = swingsAt(s, i, "low");
  const structure =
    high > previousHigh && low > previousLow ? "higher highs and higher lows" : high < previousHigh && low < previousLow ? "lower highs and lower lows" : "mixed swings";
  return { direction, strength: s.adx[i] >= 25 ? "strong" : s.adx[i] >= 20 ? "moderate" : "weak", structure };
}

const isIdx = (series: Series) => series.symbol.endsWith(".JK");
const pricingOf = (series: Series) => (isIdx(series) ? IDX : PLAIN);

export const roundPrice = (price: number, series: Series) => pricingOf(series).round(price);

/** Round-trip fees and spread assumed for a retail trader, in percent of the price. */
function costPercent(series: Series): number {
  if (isIdx(series)) return 0.45;
  if (series.kind === "forex") return 0.02;
  if (series.kind === "crypto") return 0.15;
  if (series.kind === "gold" || series.kind === "futures" || series.kind === "index") return 0.06;
  return series.currency === "USD" ? 0.06 : 0.25;
}

export type Plan = Levels & {
  side: Side;
  setup: "confluence" | "breakout";
  /** The price that has to trade for a WAIT scenario to start; undefined when the plan is live now. */
  trigger?: number;
  /** The latest price is already past the trigger, so the scenario can't be entered as written. */
  passed: boolean;
  /** Whether this setup, on this side, beat random entries by more than chance. */
  edge: boolean;
  odds: Odds[];
  random: Odds[];
};

export type Status = "READY_LONG" | "READY_SHORT" | "WAIT" | "AVOID";

export type Analysis = {
  series: Series;
  tf: Timeframe;
  /** False below daily candles, where no edge is ever claimed. */
  edgePossible: boolean;
  s: Study;
  costPercent: number;
  longOnly: boolean;
  status: Status;
  signal: number;
  trend: Trend;
  higher?: { tf: Timeframe; trend: Trend };
  levels: { supports: Level[]; resistances: Level[] };
  band?: Band;
  plans: Plan[];
  warnings: string[];
};

const RECENT = 20;

/** Recent candles nobody traded in. A flat candle alone proves nothing: USDIDR sits still for hours, and so do 1m stocks. */
const idleCandles = (series: Series) => (series.kind === "forex" ? 0 : series.candles.slice(-RECENT).filter((c) => c.volume === 0 && c.high === c.low).length);

function warningsFor(series: Series, tf: Timeframe, s: Study, now: number): string[] {
  const warnings: string[] = [];
  const days = Math.floor((now - series.priceTime) / 86_400);
  const last = s.candles.length - 1;
  if (idleCandles(series) >= RECENT / 2) warnings.push("Many recent candles have no trading: it's illiquid, so levels and odds mean little.");
  if (days > 7) warnings.push(`The last trade was ${days} days ago: it may be suspended.`);
  if (series.kind === "index") warnings.push("An index can't be traded directly, only through a fund or futures that follow it.");
  if (series.candles.length < WARMUP + HOLD + 50) warnings.push("Too little history for a meaningful backtest.");
  if (tf.seconds < 3600) warnings.push("Short timeframes lost the most in testing, because fees and spread are large against such small moves.");
  if (Math.abs(series.price - s.closes[last]) > s.atr[last]) warnings.push("The price has moved more than one ATR since the last closed candle, so re-check before using these levels.");
  return warnings;
}

/** Everything about one instrument and timeframe. Pure, so tests can feed it their own candles. */
export function analyze(series: Series, tf: Timeframe, now: number, higher?: { series: Series; tf: Timeframe }): Analysis {
  if (series.candles.length < MIN_CANDLES) {
    throw new Error(`Only ${series.candles.length} closed ${tf.label} candles exist for ${series.symbol}, too few to analyse. A different timeframe may work.`);
  }
  const s = study(series.candles, pricingOf(series));
  if (idleCandles(series) >= RECENT) throw new Error(`${series.symbol} hasn't traded in its last ${RECENT} candles, so it's probably suspended. There's nothing to analyse.`);
  const last = series.candles.length - 1;
  const cost = costPercent(series);
  const longOnly = isIdx(series); // retail traders can't short Indonesian stocks
  const round = (price: number) => roundPrice(price, series);
  const edgePossible = tf.seconds >= EDGE_TIMEFRAME;
  const sides: Side[] = longOnly ? [1] : [1, -1];

  const oddsFor = (trades: Trade[]) => oddsOf(trades.map((trade) => trade.result), trades.filter((trade) => trade.reached).length);
  const random = new Map(sides.map((side) => [side, TARGETS.map((target) => randomEntries(s, side, cost, target))]));
  /** A rule's record on one side: each target replayed on its own, as someone aiming for that target would trade. */
  const record = (rule: Rule, side: Side) => {
    const trades = TARGETS.map((target) => backtest(s, rule, side, cost, target));
    const baseline = random.get(side)!;
    return {
      odds: trades.map(oddsFor),
      random: baseline.map(oddsFor),
      edge: edgePossible && hasEdge(trades[1].map((trade) => trade.result), oddsFor(baseline[1]).average),
    };
  };

  const plan = (side: Side, planned: number, setup: Plan["setup"], past: ReturnType<typeof record>, trigger?: number): Plan | undefined => {
    const levels = levelsOf(s, last, side, planned);
    if (!levels) return undefined;
    const count = levels.targets.length;
    const passed = trigger !== undefined && (series.price - levels.entry) * side >= 0;
    return { ...levels, side, setup, trigger, passed, edge: past.edge, odds: past.odds.slice(0, count), random: past.random.slice(0, count) };
  };

  const near = levelsAt(s, last);
  // Rounding to price steps can land a level on the close, where it's neither above nor below.
  const rounded = (list: Level[], side: Side) => list.map((level) => ({ ...level, price: round(level.price) })).filter((level) => (level.price - s.closes[last]) * side > 0);
  const levels = { supports: rounded(near.supports, -1), resistances: rounded(near.resistances, 1) };
  const forecast = rangeForecast(s, horizonFor(tf));

  const signal = confluenceAt(s, last);
  const avoid = signal < 0 && longOnly;
  const confirmed = signal && !avoid ? record(confluenceEntry, signal as Side) : undefined;
  const live = confirmed?.edge ? plan(signal as Side, s.closes[last], "confluence", confirmed) : undefined;
  const status: Status = avoid ? "AVOID" : live ? (signal > 0 ? "READY_LONG" : "READY_SHORT") : "WAIT";
  const scenario = (side: Side) => {
    const candle = series.candles[last];
    const level = breakLevel(s, last, side) ?? (side > 0 ? (levels.resistances[0]?.price ?? candle.high) : (levels.supports[0]?.price ?? candle.low));
    return plan(side, level, "breakout", record(breakoutEntry, side), round(level));
  };
  const plans = live ? [live] : sides.flatMap((side) => scenario(side) ?? []);

  const higherStudy = higher && higher.series.candles.length >= MIN_CANDLES ? study(higher.series.candles) : undefined;
  return {
    series,
    tf,
    edgePossible,
    s,
    costPercent: cost,
    longOnly,
    status,
    signal,
    trend: trendAt(s, last),
    higher: higher && higherStudy && { tf: higher.tf, trend: trendAt(higherStudy, higherStudy.candles.length - 1) },
    levels,
    band: forecast && { ...forecast, low80: round(forecast.low80), high80: round(forecast.high80), low90: round(forecast.low90), high90: round(forecast.high90) },
    plans,
    warnings: warningsFor(series, tf, s, now),
  };
}

export async function analyzeMarket(market: Market, symbol: string | undefined, timeframe: string, now = Math.floor(Date.now() / 1000)): Promise<Analysis> {
  const tf = parseTimeframe(timeframe);
  const higher = higherTimeframe(tf);
  const [series, higherSeries] = await Promise.all([
    loadSeries(market, symbol, tf, now),
    higher ? loadSeries(market, symbol, higher, now).catch(() => undefined) : undefined, // only adds context
  ]);
  return analyze(series, tf, now, higher && higherSeries && { series: higherSeries, tf: higher });
}
