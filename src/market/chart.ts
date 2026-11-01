import sharp from "sharp";
import { config } from "../config.js";
import { MIN_TRADES, type Analysis, type Odds, type Plan, type Status } from "./analysis.js";

// The analysis drawn on a chart, as one PNG. Tall and with large type because it's read on a phone; the numbers sit in
// cards under the chart so the candles stay readable. The server has DejaVu fonts, the first choice below.

const WIDTH = 1080;
const CANDLES = 76;
const STEP = 9;
const CHART = { left: 16, top: 150, bottom: 780, right: CANDLES * STEP + 16 };
const CONE_END = CHART.right + 88;
const COLUMN = 90;
const AXIS = WIDTH - 112;
const VOLUME = { top: 792, bottom: 866 };
const CARD = { top: 948, height: 216, gap: 12 };
const FONT = "DejaVu Sans, Helvetica, Arial, sans-serif";
const COLOUR = {
  background: "#131722",
  card: "#1e222d",
  grid: "#2a2e39",
  text: "#d1d4dc",
  muted: "#8b90a0",
  up: "#26a69a",
  down: "#ef5350",
  ema20: "#f5c542",
  ema50: "#42a5f5",
  ema200: "#ba68c8",
  level: "#9598a1",
  band: "#5c7cfa",
  entry: "#ffffff",
};
const STATUS: Record<Status, { label: string; colour: string }> = {
  READY_LONG: { label: "SIAP LONG", colour: COLOUR.up },
  READY_SHORT: { label: "SIAP SHORT", colour: COLOUR.down },
  WAIT: { label: "TUNGGU", colour: "#f5c542" },
  AVOID: { label: "HINDARI", colour: COLOUR.down },
};
const TREND = { up: "naik", down: "turun", sideways: "sideways" };

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type TextStyle = { size?: number; colour?: string; anchor?: "start" | "middle" | "end"; bold?: boolean };

function text(x: number, y: number, content: string, { size = 22, colour = COLOUR.text, anchor = "start", bold = false }: TextStyle = {}): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${colour}" text-anchor="${anchor}"${bold ? ' font-weight="bold"' : ""}>${escape(content)}</text>`;
}

/** Text on a dark backing, for labels that sit on top of candles. */
function label(x: number, y: number, content: string, style: TextStyle & { size: number }): string {
  return box(x - 3, y - style.size, content.length * style.size * 0.6 + 6, style.size + 6, COLOUR.background, 0.8, 3) + text(x, y, content, style);
}

function line(x1: number, y1: number, x2: number, y2: number, colour: string, width = 1, dash = ""): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${colour}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

function box(x: number, y: number, width: number, height: number, colour: string, opacity = 1, radius = 0): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${Math.max(height, 1)}" fill="${colour}" fill-opacity="${opacity}" rx="${radius}"/>`;
}

function formatPrice(price: number): string {
  if (price < 1000) return price.toLocaleString("id-ID", { maximumSignificantDigits: 6 });
  const digits = Number.isInteger(price) || price >= 100_000 ? 0 : 2;
  return price.toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Older moves can squash a plan into a few pixels, so the chart zooms in on the recent candles when they would. */
function candlesToShow(a: Analysis): number {
  const levels = a.plans.flatMap((plan) => [plan.entry, plan.stop, ...plan.targets.slice(0, 2)]);
  const planSpan = Math.max(...levels) - Math.min(...levels);
  const range = (count: number) => {
    const recent = a.s.candles.slice(-count);
    return Math.max(...recent.map((c) => c.high)) - Math.min(...recent.map((c) => c.low));
  };
  return Math.min([CANDLES, 50, 32].find((count) => range(count) <= 6 * planSpan) ?? 32, a.s.candles.length);
}

function niceStep(rough: number): number {
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

/** Moves labels apart just enough to stay readable; the lines they name don't move. */
function spaced(positions: number[], gap: number): number[] {
  const order = positions.map((_, i) => i).sort((a, b) => positions[a] - positions[b]);
  const out = [...positions];
  order.forEach((index, i) => {
    if (i && out[index] - out[order[i - 1]] < gap) out[index] = out[order[i - 1]] + gap;
  });
  return out;
}

function dateLabel(seconds: number, intraday: boolean): string {
  const options: Intl.DateTimeFormatOptions = intraday ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false } : { day: "numeric", month: "short", year: "2-digit" };
  return new Date(seconds * 1000).toLocaleString("id-ID", { timeZone: config.TIMEZONE, ...options });
}

/** A target's figure: measured when there are enough past cases, otherwise what random entries did, marked "~". */
function chance(odds: Odds, random: Odds, pick: (odds: Odds) => number): string {
  if (odds.trades >= MIN_TRADES) return `${Math.round(pick(odds) * 100)}%`;
  return random.trades ? `~${Math.round(pick(random) * 100)}%` : "n/a";
}

function planBox(plan: Plan, x: number, y: (price: number) => number): string {
  const colours = { entry: COLOUR.entry, stop: COLOUR.down, target: COLOUR.up };
  const width = COLUMN - 8;
  const entry = y(plan.entry);
  const tags = [
    { name: "E", at: entry, colour: colours.entry },
    { name: "SL", at: y(plan.stop), colour: colours.stop },
    ...plan.targets.map((target, i) => ({ name: `TP${i + 1}`, at: y(target), colour: colours.target })),
  ].filter((tag) => tag.at >= CHART.top && tag.at <= CHART.bottom);
  const placed = spaced(tags.map((tag) => tag.at), 24);
  const goal = y(plan.targets[1] ?? plan.targets[0]);
  const parts = [
    box(x, Math.min(entry, goal), width, Math.abs(goal - entry), COLOUR.up, 0.22),
    box(x, Math.min(entry, y(plan.stop)), width, Math.abs(y(plan.stop) - entry), COLOUR.down, 0.22),
  ];
  tags.forEach((tag, i) => {
    parts.push(line(x, tag.at, x + width, tag.at, tag.colour, 2));
    parts.push(text(x + width / 2, placed[i] + (placed[i] <= tag.at ? -5 : 19), tag.name, { size: 19, colour: tag.colour, anchor: "middle", bold: true }));
  });
  return parts.join("");
}

function planCard(a: Analysis, plan: Plan, top: number): string {
  const colour = plan.side > 0 ? COLOUR.up : COLOUR.down;
  const arrow = plan.side > 0 ? "▲" : "▼";
  const word = plan.side > 0 ? "Long" : "Short";
  const heading =
    plan.trigger === undefined
      ? `${arrow} ${word} sekarang, sekitar ${formatPrice(plan.entry)}`
      : `${arrow} ${word} kalau harga tembus ke ${plan.side > 0 ? "atas" : "bawah"} ${formatPrice(plan.trigger)}`;
  const risk = ((plan.risk / plan.entry) * 100).toFixed(2).replace(".", ",");
  const trades = Math.min(...plan.odds.map((odds) => odds.trades));
  const source = trades >= MIN_TRADES ? `Dari ${trades} kasus serupa atau lebih, setelah biaya` : `~ dari entry acak, baru ${trades} kasus serupa`;
  const verdict = plan.edge ? "unggul dari entry acak" : "tanpa keunggulan terukur";
  const footnote = plan.passed ? "Harga sudah lewat level ini, jadi peluang di atas tidak berlaku. Tunggu candle tutup." : `${source}, ${verdict}`;
  const columns = [200, 480, 760];
  const row = (y: number, name: string, values: string[], style: TextStyle = {}) =>
    text(38, y, name, { size: 21, colour: COLOUR.muted }) + values.map((value, i) => text(columns[i], y, value, { size: 22, ...style })).join("");
  return [
    box(16, top, WIDTH - 32, CARD.height, COLOUR.card, 1, 10),
    box(16, top, 7, CARD.height, colour, 1, 3),
    text(38, top + 34, heading, { size: 25, colour, bold: true }),
    text(38, top + 67, `Entry ${formatPrice(plan.entry)} · SL ${formatPrice(plan.stop)} · Risiko ${risk}%`, { size: 23 }),
    row(top + 100, "Target", plan.targets.map((target, i) => `TP${i + 1} ${formatPrice(target)}`), { bold: true }),
    row(top + 131, "Kena TP", plan.odds.map((odds, i) => chance(odds, plan.random[i], (o) => o.reached))),
    row(top + 162, "Profit", plan.odds.map((odds, i) => chance(odds, plan.random[i], (o) => o.probability)), { colour: COLOUR.up, bold: true }),
    text(38, top + 196, footnote, { size: 18, colour: plan.passed ? STATUS.WAIT.colour : COLOUR.muted }),
  ].join("");
}

/** Lines through the last two swings, the way a trader would draw the trend by hand. */
function swingMarks(a: Analysis, first: number, x: (index: number) => number, y: (price: number) => number): string {
  const { s, trend } = a;
  const last = s.candles.length - 1;
  const parts: string[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  for (let j = 0; j <= last - 3; j++) {
    if (s.swingHigh[j]) highs.push(j);
    if (s.swingLow[j]) lows.push(j);
  }
  const labelled = (list: number[], price: (j: number) => number, up: string, down: string, offset: number) => {
    list.forEach((j, i) => {
      if (!i || j < first) return;
      parts.push(text(x(j), y(price(j)) + offset, price(j) > price(list[i - 1]) ? up : down, { size: 16, colour: COLOUR.muted, anchor: "middle" }));
    });
  };
  labelled(highs.slice(-5), (j) => s.candles[j].high, "HH", "LH", -8);
  labelled(lows.slice(-5), (j) => s.candles[j].low, "HL", "LL", 20);
  const [from, to] = (trend.direction === "up" ? lows : highs).slice(-2);
  const price = (j: number) => (trend.direction === "up" ? s.candles[j].low : s.candles[j].high);
  const rising = to !== undefined && price(to) > price(from);
  if (trend.direction !== "sideways" && to !== undefined && from >= first && rising === (trend.direction === "up")) {
    const slope = (price(to) - price(from)) / (to - from);
    const end = price(to) + slope * (last - to);
    parts.push(line(x(from), y(price(from)), x(last), y(end), trend.direction === "up" ? COLOUR.up : COLOUR.down, 2));
  }
  return parts.join("");
}

export function svgOf(a: Analysis): string {
  const { s, series, tf, band, plans, levels, trend } = a;
  const count = candlesToShow(a);
  const step = (CHART.right - CHART.left) / count;
  const first = s.candles.length - count;
  const visible = s.candles.slice(first);
  const last = s.candles.length - 1;
  const prices = [
    ...visible.flatMap((c) => [c.high, c.low]),
    ...plans.flatMap((plan) => [plan.entry, plan.stop, ...plan.targets.slice(0, 2)]),
    ...(band ? [band.low80, band.high80] : []),
  ];
  const span = Math.max(...prices) - Math.min(...prices) || Math.max(...prices) * 0.01 || 1;
  const top = Math.max(...prices) + span * 0.04;
  const bottom = Math.min(...prices) - span * 0.04;
  const y = (price: number) => CHART.top + ((top - price) / (top - bottom)) * (CHART.bottom - CHART.top);
  const x = (index: number) => CHART.left + (index - first + 0.5) * step;
  const inView = (price: number) => price >= bottom && price <= top;

  const height = CARD.top + plans.length * (CARD.height + CARD.gap) + 34;
  const parts = [box(0, 0, WIDTH, height, COLOUR.background)];

  const tick = niceStep((top - bottom) / 7);
  for (let price = Math.ceil(bottom / tick) * tick; price <= top; price += tick) {
    parts.push(line(CHART.left, y(price), AXIS, y(price), COLOUR.grid));
    parts.push(text(WIDTH - 8, y(price) + 7, formatPrice(Number(price.toPrecision(10))), { size: 20, colour: COLOUR.muted, anchor: "end" }));
  }
  const intraday = tf.unit === "m" || tf.unit === "h";
  for (let index = first + Math.round(count / 9); index <= last; index += Math.round(count / 3.5)) {
    parts.push(text(x(index), VOLUME.bottom + 30, dateLabel(s.candles[index].time, intraday), { size: 18, colour: COLOUR.muted, anchor: "middle" }));
  }

  const levelLabels: string[] = [];
  for (const [name, list] of [["R", levels.resistances], ["S", levels.supports]] as const) {
    for (const level of list.filter((l) => inView(l.price))) {
      parts.push(line(CHART.left, y(level.price), CONE_END, y(level.price), COLOUR.level, 1.5, "8 6"));
      levelLabels.push(label(CHART.left + 4, y(level.price) - 5, `${name} ${formatPrice(level.price)} (${level.touches}x)`, { size: 17, colour: COLOUR.level }));
    }
  }

  const volumes = visible.map((c) => c.volume);
  const loudest = Math.max(...volumes) || 1;
  const body = Math.max(step * 0.66, 3);
  visible.forEach((c, offset) => {
    const index = first + offset;
    const colour = c.close >= c.open ? COLOUR.up : COLOUR.down;
    const bodyTop = y(Math.max(c.open, c.close));
    parts.push(line(x(index), y(c.high), x(index), y(c.low), colour, 1.5));
    parts.push(box(x(index) - body / 2, bodyTop, body, y(Math.min(c.open, c.close)) - bodyTop, colour));
    if (s.hasVolume[last]) {
      const height = (c.volume / loudest) * (VOLUME.bottom - VOLUME.top);
      parts.push(box(x(index) - body / 2, VOLUME.bottom - height, body, height, colour, 0.6));
    }
  });
  if (!s.hasVolume[last]) parts.push(text(CHART.left, VOLUME.top + 40, "Pasar ini tanpa data volume", { size: 18, colour: COLOUR.muted }));

  // Averages can run far off the scale; without a clip they'd cross the header.
  parts.push('<g clip-path="url(#chart)">');
  for (const [values, colour] of [[s.ema20, COLOUR.ema20], [s.ema50, COLOUR.ema50], [s.ema200, COLOUR.ema200]] as const) {
    const points = values.slice(first).flatMap((value, offset) => (Number.isNaN(value) ? [] : [`${x(first + offset).toFixed(1)},${y(value).toFixed(1)}`]));
    if (points.length > 1) parts.push(`<polyline points="${points.join(" ")}" fill="none" stroke="${colour}" stroke-width="2"/>`);
  }
  parts.push(swingMarks(a, first, x, y), "</g>", ...levelLabels);

  const closeX = x(last);
  const closeY = y(s.closes[last]);
  if (band) {
    const points = `${closeX},${closeY} ${CONE_END},${y(band.high80)} ${CONE_END},${y(band.low80)}`;
    parts.push(`<polygon points="${points}" fill="${COLOUR.band}" fill-opacity="0.25" stroke="${COLOUR.band}" stroke-width="1.5"/>`);
    parts.push(text(CONE_END - 4, y(band.high80) - 8, "80%", { size: 18, colour: COLOUR.band, anchor: "end" }));
  }
  plans.forEach((plan, i) => parts.push(planBox(plan, CONE_END + 6 + i * COLUMN, y)));

  const tagColour = s.closes[last] >= s.candles[last].open ? COLOUR.up : COLOUR.down;
  parts.push(box(AXIS + 4, closeY - 16, WIDTH - AXIS - 8, 32, tagColour, 1, 4));
  parts.push(text(WIDTH - 12, closeY + 7, formatPrice(s.closes[last]), { size: 20, colour: "#ffffff", anchor: "end", bold: true }));

  const status = STATUS[a.status];
  const higher = a.higher ? ` · ${a.higher.tf.label}: ${TREND[a.higher.trend.direction]}` : "";
  parts.push(text(16, 56, `${series.symbol.replace(/=X$/, "")} · ${tf.label.toUpperCase()}`, { size: 44, bold: true }));
  parts.push(text(16, 94, series.name.slice(0, 46), { size: 23, colour: COLOUR.muted }));
  parts.push(text(16, 130, `Tren ${TREND[trend.direction]}${higher} · RSI ${Number.isNaN(s.rsi[last]) ? "-" : s.rsi[last].toFixed(0)} · ADX ${Number.isNaN(s.adx[last]) ? "-" : s.adx[last].toFixed(0)}`, { size: 23 }));
  const badge = status.label.length * 23 + 36;
  parts.push(box(WIDTH - 16 - badge, 22, badge, 60, status.colour, 1, 10));
  parts.push(text(WIDTH - 16 - badge / 2, 64, status.label, { size: 34, colour: "#131722", anchor: "middle", bold: true }));
  [["EMA20", COLOUR.ema20], ["EMA50", COLOUR.ema50], ["EMA200", COLOUR.ema200]].forEach(([label, colour], i) => {
    parts.push(text(WIDTH - 16 - (2 - i) * 110, 118, label, { size: 19, colour, anchor: "end" }));
  });

  if (band) {
    parts.push(text(16, 932, `Rentang ${band.candles} candle ke depan (80%): ${formatPrice(band.low80)} – ${formatPrice(band.high80)}`, { size: 24, bold: true }));
  }
  plans.forEach((plan, i) => parts.push(planCard(a, plan, CARD.top + i * (CARD.height + CARD.gap))));
  const note = a.status === "AVOID" ? "Sinyal turun: saham Indonesia tidak bisa short. " : "";
  parts.push(text(16, height - 12, `${note}Peluang = frekuensi historis, bukan janji. Bukan saran investasi.`, { size: 18, colour: COLOUR.muted }));

  const clip = `<defs><clipPath id="chart"><rect x="0" y="${CHART.top}" width="${WIDTH}" height="${CHART.bottom - CHART.top}"/></clipPath></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">${clip}${parts.join("")}</svg>`;
}

/** The chart as a PNG. */
export function chartOf(a: Analysis): Promise<Buffer> {
  return sharp(Buffer.from(svgOf(a))).png({ compressionLevel: 9 }).toBuffer();
}
