import { formatDateTime } from "../time.js";
import { HOLD, MIN_TRADES, roundPrice, TARGETS, type Analysis, type Odds, type Plan } from "./analysis.js";

// What Claude reads. It stays in the chat's history, so it has to carry enough to answer follow-up questions: why each
// level is where it is, and the risk per unit that position sizes are worked out from.

const percent = (value: number) => `${Math.round(value * 100)}%`;
const inR = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
const stamp = (seconds: number) => formatDateTime(new Date(seconds * 1000));
const decimal = (value: number, digits = 1) => (Number.isNaN(value) ? "n/a" : value.toFixed(digits));
/** For distances and averages, which aren't prices an order could be placed at, so ticks don't apply. */
const amount = (value: number) => (Number.isNaN(value) ? "n/a" : Number(value.toPrecision(6)));

function compact(volume: number): string {
  const [divisor, suffix] = volume >= 1e9 ? [1e9, "B"] : volume >= 1e6 ? [1e6, "M"] : volume >= 1e3 ? [1e3, "K"] : [1, ""];
  return `${(volume / divisor).toFixed(1)}${suffix}`;
}

function statusLine(a: Analysis): string {
  const direction = a.signal > 0 ? "long" : "short";
  switch (a.status) {
    case "READY_LONG":
    case "READY_SHORT":
      return `Status: READY ${direction.toUpperCase()}. All indicators just turned ${a.signal > 0 ? "up" : "down"}, and on this instrument this setup beat random entries by more than chance. Plans only get here because their past figures are high, so expect less than they show, and the edge may not last.`;
    case "AVOID":
      return "Status: AVOID. All indicators just turned down. Retail traders can't short Indonesian stocks, so the only plan is what would have to change before going long.";
    default:
      if (!a.signal) return "Status: WAIT. There's no fresh signal: the indicators disagree, or the move is already under way. The scenarios say what has to happen first.";
      return a.edgePossible
        ? `Status: WAIT. A fresh ${direction} signal formed, but on this instrument it hasn't beaten random entries, so it isn't treated as an entry.`
        : `Status: WAIT. A fresh ${direction} signal formed, but below daily candles these signals lost money after costs in testing, so it isn't treated as an entry.`;
  }
}

function oddsLine(target: number, odds: Odds, random: Odds): string {
  const figures = (o: Odds) => `reached ${percent(o.reached)}, ended in profit ${percent(o.probability)}`;
  const measured = odds.trades ? `${odds.trades} past cases, ${figures(odds)} (profit range ${percent(odds.low)}-${percent(odds.high)}), average ${inR(odds.average)}` : "no past cases";
  const baseline = random.trades ? `random entries ${figures(random)}, average ${inR(random.average)}` : "no random-entry figures";
  return `  TP${target}: ${measured}; ${baseline}`;
}

function edgeLine(a: Analysis, plan: Plan): string {
  if (plan.edge) return "This setup beat random entries by more than chance.";
  if ((plan.odds[1] ?? plan.odds[0]).trades < MIN_TRADES) return "Too few past cases to judge: lean on the random-entry figures.";
  return a.edgePossible ? "No measured edge: this setup hasn't beaten random entries here." : "No edge is claimed below daily candles: these setups lost money after costs in testing.";
}

function planLines(a: Analysis, plan: Plan, index: number): string[] {
  const price = (value: number) => roundPrice(value, a.series);
  const direction = plan.side > 0 ? "Long" : "Short";
  const heading =
    plan.trigger === undefined
      ? `Plan: ${direction} now, around ${plan.entry}.`
      : `Scenario ${index + 1}: ${direction} only if price trades ${plan.side > 0 ? "above" : "below"} ${plan.trigger}, like a stop order resting there.`;
  const stopBasis = plan.swing === undefined ? "1.5 ATR from the entry" : `past the swing ${plan.side > 0 ? "low" : "high"} at ${price(plan.swing)}, plus 0.25 ATR`;
  const perUnit = a.longOnly ? `${amount(plan.risk)} per share, ${amount(plan.risk * 100)} per lot of 100` : `${amount(plan.risk)} per unit`;
  const setup = plan.setup === "confluence" ? "all indicators turning the same way" : "price breaking the nearest swing or the last five candles' extreme";
  const missing = plan.targets.length < TARGETS.length ? " Targets past zero are left out." : "";
  return [
    heading,
    `  Entry ${plan.entry}. Stop ${plan.stop} (${stopBasis}). Risk ${perUnit}, ${((plan.risk / plan.entry) * 100).toFixed(2)}% of the entry.`,
    `  Targets: ${plan.targets.map((target, i) => `TP${i + 1} ${target} (${TARGETS[i]}R)`).join(", ")}.${missing} Leave after ${HOLD} candles if neither stop nor target is reached.`,
    `  Chance of profit, from past cases of this setup (${setup}) on this side:`,
    ...plan.odds.map((odds, i) => oddsLine(i + 1, odds, plan.random[i])),
    `  ${edgeLine(a, plan)}`,
    ...(plan.passed ? [`  Price is already past this entry, so this scenario can't be entered as written and these figures don't apply to it now. Say so, and that it's worth waiting for this candle to close and analysing again.`] : []),
  ];
}

export function reportOf(a: Analysis): string {
  const { series, s, tf, band, trend, levels } = a;
  const last = s.candles.length - 1;
  const candle = s.candles[last];
  const level = (list: { price: number; touches: number }[]) =>
    list.map((l) => `${l.price} (${l.touches} touch${l.touches > 1 ? "es" : ""})`).join(", ") || "none in recent history";
  const hasVolume = s.hasVolume[last] && s.volumeAverage[last] > 0;
  const volume = hasVolume
    ? `Volume ${(candle.volume / s.volumeAverage[last]).toFixed(1)}x its 20-candle average, OBV ${s.obv[last] > s.obvAverage[last] ? "above" : "below"} its average.`
    : "No volume data for this market.";
  const bandLine = band
    ? `Range: after ${band.candles} ${tf.label} candles the close should be between ${band.low80} and ${band.high80} (80%), or ${band.low90} and ${band.high90} (90%).` +
      (band.checks ? ` On this instrument the 80% band held in ${percent(band.hits / band.checks)} of ${band.checks} past checks.` : "")
    : "Range: not enough history.";
  return [
    `MARKET ANALYSIS of ${series.name} (${series.symbol}), ${series.kind}, ${series.currency || "no currency given"}, ${tf.label} candles. Computed from real market data: use these numbers exactly.`,
    `Data: ${series.source}, ${s.candles.length} closed candles, the last opening ${stamp(candle.time)}. Latest price ${series.price} at ${stamp(series.priceTime)}.`,
    "",
    `Trend: ${trend.direction}, ${trend.strength} (EMA20 ${amount(s.ema20[last])}, EMA50 ${amount(s.ema50[last])}, EMA200 ${amount(s.ema200[last])}; ADX ${decimal(s.adx[last])}, +DI ${decimal(s.plusDi[last])}, -DI ${decimal(s.minusDi[last])}; ${trend.structure}).` +
      (a.higher ? ` ${a.higher.tf.label} trend: ${a.higher.trend.direction}, ${a.higher.trend.strength}.` : ""),
    `Momentum: RSI ${decimal(s.rsi[last])}, MACD histogram ${amount(s.macd[last])} (previous ${amount(s.macd[last - 1])}). ATR ${amount(s.atr[last])}. ${volume}`,
    `Resistance: ${level(levels.resistances)}.`,
    `Support: ${level(levels.supports)}.`,
    bandLine,
    "",
    statusLine(a),
    `Past cases replay these exact rules: stop and targets fixed in advance from the entry, a scenario filled at its entry as soon as price trades there or at the open if it gaps past, a live plan filled at the next open, ${a.costPercent}% round-trip costs deducted, and a candle touching the stop together with the entry or a target counted as a loss. "Reached" means the target came before the stop; "ended in profit" also counts trades that left at the time limit with a gain. Averages are in multiples of the risk shown.`,
    "",
    ...a.plans.flatMap((plan, i) => planLines(a, plan, i)),
    "",
    `Last closed candles: ${s.candles.slice(-5).map((c) => `${stamp(c.time)} O ${roundPrice(c.open, series)} H ${roundPrice(c.high, series)} L ${roundPrice(c.low, series)} C ${roundPrice(c.close, series)}${hasVolume ? ` V ${compact(c.volume)}` : ""}`).join(" | ")}`,
    ...(a.warnings.length ? ["", `Warnings: ${a.warnings.join(" ")}`] : []),
    "",
    "How to answer: the chart is already in the chat, with these levels drawn on it, so don't describe the picture. In their language and WhatsApp style give the status and why, the trend and key levels, the range, then the plan: entry, stop, targets, and when it's cancelled. Per target show the chance it's reached and the chance of ending in profit with its range, the number of past cases and the average result, next to the random-entry figures. Never present the profit figure as the chance of reaching a target. Say plainly when there's no measured edge. Those chances are how often this setup paid in the past, not a forecast. Never invent a level or a chance, and never say a trade will win. End with one line: this isn't investment advice and you aren't a licensed adviser.",
    "Follow-up questions: answer from these numbers while they're current. A scenario's entry only holds until the next candle closes, so call market_analysis again then, or for another timeframe or symbol. A position size is the amount they choose to risk divided by the risk per unit; how much to risk is their decision, so ask rather than suggest one.",
  ].join("\n");
}
