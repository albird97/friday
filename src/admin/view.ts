import {
  RANGES,
  type AssetUrl,
  type Attention,
  type DayStat,
  type Flash,
  type GroupRow,
  type LoginView,
  type PersonRow,
  type ScheduleRow,
  type Section,
  type Snapshot,
  type ViewContext,
} from "./types.js";

// The dashboard's HTML, from a Snapshot. No database, no I/O: everything shown comes in through the Snapshot, and every
// value that came from a person (names, group names, schedule text, log lines, user agents) is escaped by html``.
// Charts are plain HTML and SVG drawn here; assets/dashboard.js only adds tooltips, refresh, sorting and the like, so the
// page reads fine without it.

// ── Safe HTML ────────────────────────────────────────────────────────────────────────────────────────────────────

class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}
type Part = Html | string | number | null | undefined | false | Part[];

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

function out(value: Part): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(out).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(String(value));
}

/** A template whose interpolations are escaped unless they're Html already. */
function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let text = strings[0];
  values.forEach((value, i) => (text += out(value) + strings[i + 1]));
  return new Html(text);
}

const num4 = (n: number) => (Number.isFinite(n) ? Number(n.toFixed(4)) : 0);
const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

// ── Words and numbers ────────────────────────────────────────────────────────────────────────────────────────────

const SECTION_NAMES: Record<Section, string> = {
  ringkasan: "Ringkasan",
  biaya: "Biaya",
  aktivitas: "Aktivitas",
  orang: "Orang",
  grup: "Grup",
  jadwal: "Jadwal",
  fitur: "Fitur",
  sistem: "Sistem",
  keamanan: "Keamanan",
};

const TOOL_NAMES: Record<string, string> = {
  web_search: "Cari di web",
  web_fetch: "Buka halaman web",
  create_reminder: "Buat pengingat",
  list_reminders: "Lihat jadwal",
  cancel_reminder: "Batalkan jadwal",
  schedule_task: "Jadwalkan tugas",
  create_document: "Buat dokumen",
  create_spreadsheet: "Buat spreadsheet",
  create_presentation: "Buat presentasi",
  generate_image: "Buat gambar",
  edit_image: "Edit gambar",
  create_poll: "Buat polling",
  poll_results: "Hasil polling",
  remember: "Ingat sesuatu",
  forget: "Lupakan ingatan",
  send_message: "Titip pesan",
  send_group_message: "Kirim ke grup",
  set_profile_picture: "Ganti foto profil",
  start_errand: "Mulai urusan",
  errand_reply: "Balas urusan",
  list_errands: "Daftar urusan",
  end_errand: "Akhiri urusan",
  ask_requester: "Tanya pemberi urusan",
  finish_errand: "Selesaikan urusan",
  market_analysis: "Analisis pasar",
  voice_note: "Transkrip voice note",
  onehub_query: "onehub · cari data",
  onehub_schema: "onehub · lihat tabel",
};
const TOOL_FAMILIES: [prefix: string, name: string][] = [
  ["google_", "Google"],
  ["hevy_", "Hevy"],
  ["group_workout_", "Workout bareng"],
  ["spotify_", "Spotify"],
  ["shopee_", "Shopee"],
  ["smartlife_", "Smart Life"],
];
/** "google_calendar_add" → "Google · calendar add". */
function toolName(tool: string): string {
  if (TOOL_NAMES[tool]) return TOOL_NAMES[tool];
  const family = TOOL_FAMILIES.find(([prefix]) => tool.startsWith(prefix));
  const rest = (family ? tool.slice(family[0].length) : tool).replace(/_/g, " ");
  return family ? `${family[1]} · ${rest}` : rest;
}

const ERRAND_STATUS: Record<string, [label: string, tone: Tone]> = {
  pending: ["Menunggu", "neutral"],
  active: ["Berjalan", "accent"],
  done: ["Selesai", "good"],
  cancelled: ["Dibatalkan", "neutral"],
  expired: ["Kedaluwarsa", "neutral"],
};

/** WhatsApp's disconnect codes (Baileys' DisconnectReason), in words. */
const DISCONNECTS: Record<string, string> = {
  "401": "dikeluarkan dari WhatsApp",
  "403": "ditolak WhatsApp",
  "408": "koneksi habis waktu",
  "411": "perangkat tidak cocok",
  "428": "koneksi ditutup",
  "440": "diganti sesi lain",
  "500": "sesi rusak",
  "503": "WhatsApp sedang gangguan",
  "515": "restart rutin",
};

const STYLE_NAMES: Record<string, string> = { chill: "Chill", formal: "Formal", funny: "Lucu", ngeyel: "Ngeyel" };

/** "claude-opus-5-5" → "Opus 5.5". */
function modelName(model: string): string {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (!m) return model;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

type Fmt = ReturnType<typeof formatting>;

function formatting(s: Pick<Snapshot, "timezone" | "generatedAt" | "settings">) {
  const tz = s.timezone;
  const now = s.generatedAt;
  const rate = s.settings.usdToIdr;
  const make = (options: Intl.DateTimeFormatOptions, zone = tz) => new Intl.DateTimeFormat("id-ID", { timeZone: zone, ...options });
  const time = make({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const timeSec = make({ hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const dayMonth = make({ day: "numeric", month: "short" });
  const weekdayDay = make({ weekday: "short", day: "numeric", month: "short" });
  const full = make({ weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const dateYear = make({ day: "numeric", month: "short", year: "numeric" });
  // Day strings are calendar dates: format them in UTC so the zone can't move them.
  const utcWeekday = make({ weekday: "short" }, "UTC");
  const utcWeekdayDay = make({ weekday: "short", day: "numeric", month: "short" }, "UTC");
  const utcDayMonth = make({ day: "numeric", month: "short" }, "UTC");
  const utcLong = make({ weekday: "long", day: "numeric", month: "long" }, "UTC");
  const localDay = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(ms);
  const today = localDay(now);
  const shift = (day: string, by: number) => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
  };
  const yesterday = shift(today, -1);
  const tomorrow = shift(today, 1);
  const asDate = (day: string) => new Date(`${day}T12:00:00Z`);

  const decimals = (n: number, digits: number) => n.toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });

  const f = {
    now,
    today,
    int: (n: number) => Math.round(n).toLocaleString("id-ID"),
    usd: (n: number) => (n > 0 && n < 0.005 ? "<$0,01" : `$${decimals(n, 2)}`),
    usdTick: (n: number) => (Number.isInteger(n) ? `$${n.toLocaleString("id-ID")}` : `$${decimals(n, 2)}`),
    idr: (dollars: number) => `Rp${Math.round(dollars * rate).toLocaleString("id-ID")}`,
    compact: (n: number) => {
      if (n >= 1e9) return `${decimals(n / 1e9, 1)} M`;
      if (n >= 1e6) return `${decimals(n / 1e6, 1)} jt`;
      if (n >= 1e4) return `${Math.round(n / 1e3).toLocaleString("id-ID")} rb`;
      if (n >= 1e3) return `${decimals(n / 1e3, 1)} rb`;
      return Math.round(n).toLocaleString("id-ID");
    },
    pct: (share: number) => `${Math.round(share * 100)}%`,
    bytes: (n: number) => {
      if (n >= 1024 ** 3) return `${decimals(n / 1024 ** 3, 1)} GB`;
      if (n >= 1024 ** 2) return `${decimals(n / 1024 ** 2, n >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
      if (n >= 1024) return `${Math.round(n / 1024)} KB`;
      return `${n} B`;
    },
    /** 4200 → "4,2 dtk"; 65 000 → "1 mnt 5 dtk". */
    seconds: (ms: number | null) => {
      if (ms === null) return "–";
      if (ms < 10_000) return `${decimals(ms / 1000, 1)} dtk`;
      if (ms < 60_000) return `${Math.round(ms / 1000)} dtk`;
      const total = Math.round(ms / 1000);
      return `${Math.floor(total / 60)} mnt${total % 60 ? ` ${total % 60} dtk` : ""}`;
    },
    /** 93 784 000 → "1 hari 2 jam". The two biggest units. */
    span: (ms: number) => {
      const minutes = Math.floor(ms / 60_000);
      const parts: [number, string][] = [
        [Math.floor(minutes / 1440), "hari"],
        [Math.floor(minutes / 60) % 24, "jam"],
        [minutes % 60, "mnt"],
      ];
      const first = parts.findIndex(([n]) => n > 0);
      if (first < 0) return "kurang dari 1 mnt";
      return parts
        .slice(first, first + 2)
        .filter(([n]) => n > 0)
        .map(([n, unit]) => `${n} ${unit}`)
        .join(" ");
    },
    time: (ms: number) => time.format(ms),
    timeSec: (ms: number) => timeSec.format(ms),
    full: (ms: number) => full.format(ms),
    /** "hari ini 14.05", "kemarin 09.30", "Sen, 3 Nov 14.05", "3 Nov 2025". */
    when: (ms: number) => {
      const day = localDay(ms);
      if (day === today) return `hari ini ${time.format(ms)}`;
      if (day === yesterday) return `kemarin ${time.format(ms)}`;
      if (day === tomorrow) return `besok ${time.format(ms)}`;
      if (Math.abs(now - ms) < 180 * 86_400_000) return `${weekdayDay.format(ms)} ${time.format(ms)}`;
      return dateYear.format(ms);
    },
    /** "baru saja", "5 mnt lalu", "3 jam lalu", then like when(). */
    ago: (ms: number): string => {
      const diff = now - ms;
      if (diff < 0) return f.until(ms);
      if (diff < 45_000) return "baru saja";
      if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} mnt lalu`;
      if (diff < 6 * 3_600_000) return `${Math.floor(diff / 3_600_000)} jam lalu`;
      return f.when(ms);
    },
    /** "dalam 5 mnt", "dalam 3 jam", then like when(). */
    until: (ms: number): string => {
      const diff = ms - now;
      if (diff <= 0) return f.ago(ms);
      if (diff < 3_600_000) return `dalam ${Math.max(1, Math.round(diff / 60_000))} mnt`;
      if (diff < 6 * 3_600_000) return `dalam ${Math.round(diff / 3_600_000)} jam`;
      return f.when(ms);
    },
    dayShort: (day: string) => utcDayMonth.format(asDate(day)),
    weekday: (day: string) => utcWeekday.format(asDate(day)),
    dayLabel: (day: string) => (day === today ? "Hari ini" : day === yesterday ? "Kemarin" : utcWeekdayDay.format(asDate(day))),
    dayLong: (day: string) => (day === today ? "Hari ini" : day === tomorrow ? "Besok" : utcLong.format(asDate(day))),
    dateShort: (ms: number) => dayMonth.format(ms),
    localDay,
  };
  return f;
}

// ── Small pieces ─────────────────────────────────────────────────────────────────────────────────────────────────

const ICONS: Record<string, string> = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  warning: '<path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  serious: '<path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  critical: '<path d="M7.9 2.5h8.2l5.4 5.4v8.2l-5.4 5.4H7.9l-5.4-5.4V7.9Z"/><path d="M12 8v4.5"/><path d="M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.5L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.9 3.5L20 15"/><path d="M20 20v-5h-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>',
  system: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<path d="M7 4.5v15l12-7.5Z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.5L3 21l2-5.7A8.4 8.4 0 1 1 21 11.5Z"/>',
  group: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  crown: '<path d="M3 7.5 7.5 11 12 4.5l4.5 6.5L21 7.5 19 19H5Z"/>',
  spark: '<path d="M12 3c.6 4.4 2.6 6.4 7 7-4.4.6-6.4 2.6-7 7-.6-4.4-2.6-6.4-7-7 4.4-.6 6.4-2.6 7-7Z"/><path d="M19 15.5c.3 1.7 1 2.4 2.5 2.7-1.5.3-2.2 1-2.5 2.7-.3-1.7-1-2.4-2.5-2.7 1.5-.3 2.2-1 2.5-2.7Z"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  shield: '<path d="M12 21.5s8-3.8 8-9.8V5.4L12 2.5 4 5.4v6.3c0 6 8 9.8 8 9.8Z"/><path d="m9 12 2 2 4-4"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M15 8l2 2"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
};

function icon(name: keyof typeof ICONS | string, cls = ""): Html {
  return new Html(
    `<svg class="i${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] ?? ""}</svg>`,
  );
}

type Tone = "neutral" | "accent" | "good" | "warning" | "serious" | "critical" | "info";

function chip(text: Part, tone: Tone = "neutral", extra?: Html): Html {
  return html`<span class="chip chip-${tone}">${extra ?? ""}${text}</span>`;
}

const SEVERITY: Record<Attention["severity"], { label: string; tone: Tone }> = {
  critical: { label: "Kritis", tone: "critical" },
  serious: { label: "Serius", tone: "serious" },
  warning: { label: "Perhatian", tone: "warning" },
  info: { label: "Info", tone: "info" },
};

/** A status dot with its words beside it: color never carries the meaning alone. */
function dot(tone: Tone, label: Part, live = false): Html {
  return html`<span class="dot dot-${tone}${live ? " dot-live" : ""}"><span class="dot-mark" aria-hidden="true"></span>${label}</span>`;
}

/** A ratio against a limit. Severity from `warnAt`/`badAt` (shares of the limit). */
function meter(value: number, max: number, label: string, warnAt = 0.8, badAt = 0.9): Html {
  const share = max > 0 ? value / max : 0;
  const tone = share >= badAt ? "serious" : share >= warnAt ? "warning" : "accent";
  return html`<span class="meter meter-${tone}" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="${num4(max)}" aria-valuenow="${num4(Math.min(value, max))}"><span class="meter-fill" style="--v:${num4(clamp01(share))}"></span></span>`;
}

function copyButton(text: string, label = "Salin"): Html {
  return html`<button class="btn btn-small btn-quiet" type="button" data-copy="${text}">${icon("copy")}<span data-copy-label>${label}</span></button>`;
}

function emptyState(text: Part, iconName = "info"): Html {
  return html`<p class="empty">${icon(iconName)}<span>${text}</span></p>`;
}

function panel(opts: { title: Part; sub?: Part; tools?: Part; body: Part; cls?: string; id?: string }): Html {
  return html`<section class="panel${opts.cls ? ` ${opts.cls}` : ""}"${opts.id ? new Html(` id="${escapeHtml(opts.id)}"`) : ""}>
  <header class="panel-head"><div class="panel-titles"><h3 class="panel-title">${opts.title}</h3>${opts.sub ? html`<p class="panel-sub">${opts.sub}</p>` : ""}</div>${opts.tools ? html`<div class="panel-tools">${opts.tools}</div>` : ""}</header>
  ${opts.body}
</section>`;
}

/** The accessible twin of a chart: every value as a table, folded away until asked for. */
function tableView(key: string, head: string[], rows: Part[][]): Html {
  return html`<details class="tableview" data-keep="${key}">
  <summary>Lihat sebagai tabel</summary>
  <div class="tbl-wrap"><table class="tbl tbl-compact"><thead><tr>${head.map((h, i) => html`<th scope="col"${i ? new Html(' class="num"') : ""}>${h}</th>`)}</tr></thead>
  <tbody>${rows.map((r) => html`<tr>${r.map((c, i) => (i ? html`<td class="num">${c}</td>` : html`<th scope="row">${c}</th>`))}</tr>`)}</tbody></table></div>
</details>`;
}

// ── Charts ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A round top for an axis: 0.37 → 0.4 with ticks [0, 0.2, 0.4]. */
function scale(max: number, integer = false): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: integer ? 4 : 1, ticks: integer ? [0, 2, 4] : [0, 0.5, 1] };
  const rough = max / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((candidate) => candidate >= rough) ?? 10 * power;
  if (integer) step = Math.max(1, Math.ceil(step));
  const top = step * Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { top, ticks };
}

/** Which x labels to print: always today (the last), then every k-th going back. */
function xLabels(days: string[], f: Fmt): Html {
  const n = days.length;
  const every = n <= 8 ? 1 : n <= 31 ? 7 : 14;
  return html`<div class="chart-x" style="--n:${n}" aria-hidden="true">${days.map((day, i) => {
    const show = (n - 1 - i) % every === 0;
    const label = n <= 8 ? f.weekday(day) : f.dayShort(day);
    return html`<span>${show ? label : ""}</span>`;
  })}</div>`;
}

function yAxis(ticks: number[], top: number, label: (n: number) => string): Html {
  return html`<div class="chart-y" aria-hidden="true">${ticks.map((t) => html`<span class="chart-tick" style="--y:${num4(t / top)}"><span>${label(t)}</span></span>`)}</div>`;
}

type Bar = { day: string; parts: number[]; tip: string[] };

/** Daily columns: one series, or a stack of two (with a 2px gap between the parts). */
function dailyColumns(opts: {
  key: string;
  aria: string;
  bars: Bar[];
  tick: (n: number) => string;
  integer?: boolean;
  threshold?: { value: number; label: string };
  f: Fmt;
}): Html {
  const totals = opts.bars.map((b) => b.parts.reduce((a, v) => a + v, 0));
  const peak = Math.max(0, ...totals);
  const threshold = opts.threshold && opts.threshold.value > 0 && opts.threshold.value <= Math.max(peak * 1.6, 0.000001) ? opts.threshold : undefined;
  const { top, ticks } = scale(Math.max(peak, threshold?.value ?? 0), opts.integer);
  return html`<div class="chart" data-chart tabindex="0" role="img" aria-label="${opts.aria}">
  <div class="chart-body">
    ${yAxis(ticks, top, opts.tick)}
    <div class="chart-plot">
      ${ticks.map((t) => html`<span class="chart-grid${t === 0 ? " chart-base" : ""}" style="--y:${num4(t / top)}"></span>`)}
      ${threshold ? html`<span class="chart-limit" style="--y:${num4(threshold.value / top)}"><span>${threshold.label}</span></span>` : ""}
      <div class="cols" style="--n:${opts.bars.length}">${opts.bars.map((bar, i) => {
        const total = totals[i];
        return html`<span class="col${bar.day === opts.f.today ? " col-today" : ""}" data-tip="${bar.tip.join("\n")}" style="--i:${i}"><span class="col-stack" style="--v:${num4(total / top)}">${bar.parts.map((v, p) =>
          v > 0 ? html`<span class="col-part s${p + 1}" style="--share:${num4(v / total)}"></span>` : "",
        )}</span></span>`;
      })}</div>
    </div>
  </div>
  ${xLabels(opts.bars.map((b) => b.day), opts.f)}
</div>`;
}

/** Response times per day: median and 95th percentile as two lines on one axis (both seconds). */
function latencyLines(days: DayStat[], f: Fmt): Html {
  const values = days.flatMap((d) => [d.p50Ms, d.p95Ms]).filter((v): v is number => v !== null);
  if (values.length === 0) return emptyState("Belum ada jawaban dalam periode ini.");
  const { top, ticks } = scale(Math.max(...values) / 1000);
  const n = days.length;
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const y = (ms: number) => 100 - (ms / 1000 / top) * 100;
  const runs = (pick: (d: DayStat) => number | null) => {
    const lines: string[][] = [[]];
    days.forEach((d, i) => {
      const v = pick(d);
      if (v === null) {
        if (lines.at(-1)!.length) lines.push([]);
      } else lines.at(-1)!.push(`${num4(x(i))},${num4(y(v))}`);
    });
    return lines.filter((l) => l.length);
  };
  const line = (cls: string, pick: (d: DayStat) => number | null) =>
    runs(pick).map((points) =>
      points.length === 1
        ? html`<line class="${cls}" x1="${points[0].split(",")[0]}" y1="${points[0].split(",")[1]}" x2="${points[0].split(",")[0]}" y2="${points[0].split(",")[1]}" />`
        : html`<polyline class="${cls}" points="${points.join(" ")}" />`,
    );
  const lastWith = (pick: (d: DayStat) => number | null) => {
    for (let i = n - 1; i >= 0; i--) if (pick(days[i]) !== null) return { i, v: pick(days[i])! };
    return undefined;
  };
  const ends = [
    { cls: "s1", name: "Median", end: lastWith((d) => d.p50Ms) },
    { cls: "s2", name: "95%", end: lastWith((d) => d.p95Ms) },
  ];
  return html`<div class="chart chart-line" data-chart tabindex="0" role="img" aria-label="Waktu balas per hari: median dan 95 persen jawaban, dalam detik.">
  <div class="legend" aria-hidden="true"><span class="legend-item"><span class="key key-line s1"></span>Median</span><span class="legend-item"><span class="key key-line s2"></span>95% jawaban lebih cepat</span></div>
  <div class="chart-body">
    ${yAxis(ticks, top, (t) => `${t.toLocaleString("id-ID")} dtk`)}
    <div class="chart-plot">
      ${ticks.map((t) => html`<span class="chart-grid${t === 0 ? " chart-base" : ""}" style="--y:${num4(t / top)}"></span>`)}
      <svg class="lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${line("s2", (d) => d.p95Ms)}${line("s1", (d) => d.p50Ms)}</svg>
      ${ends.map((e) => (e.end ? html`<span class="end-dot ${e.cls}" style="--x:${num4(x(e.end.i) / 100)};--y:${num4(1 - y(e.end.v) / 100)}"></span>` : ""))}
      <div class="cols cols-hit" style="--n:${n}">${days.map(
        (d, i) => html`<span class="col col-hit" style="--i:${i}" data-tip="${[f.dayLabel(d.day), d.p50Ms === null ? "Belum ada jawaban" : `Median ${f.seconds(d.p50Ms)}`, d.p95Ms === null ? "" : `95% di bawah ${f.seconds(d.p95Ms)}`, `${f.int(d.messages)} pesan`].filter(Boolean).join("\n")}"></span>`,
      )}</div>
    </div>
  </div>
  ${xLabels(days.map((d) => d.day), f)}
</div>`;
}

const WEEKDAYS = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];
const WEEKDAYS_LONG = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];
const hour = (h: number) => `${String(h).padStart(2, "0")}.00`;

function heatmap(grid: number[][]): Html {
  const peak = Math.max(0, ...grid.flat());
  if (peak === 0) return emptyState("Belum ada pesan dalam periode ini.");
  const bin = (v: number) => (v === 0 ? 0 : Math.max(1, Math.ceil((v / peak) * 5)));
  return html`<div class="heat" data-chart tabindex="0" role="img" aria-label="Jumlah pesan per hari dan jam. Paling ramai ${peak} pesan dalam satu jam.">
  <div class="heat-hours" aria-hidden="true"><span></span>${Array.from({ length: 24 }, (_, h) => html`<span>${h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>`)}</div>
  ${grid.map(
    (row, d) => html`<div class="heat-row"><span class="heat-day">${WEEKDAYS[d]}</span>${row.map(
      (v, h) => html`<span class="heat-cell h${bin(v)}" data-tip="${`${WEEKDAYS_LONG[d]}, ${hour(h)}–${hour((h + 1) % 24)}\n${v} pesan`}"></span>`,
    )}</div>`,
  )}
  <div class="heat-scale" aria-hidden="true"><span>Sepi</span>${[0, 1, 2, 3, 4, 5].map((b) => html`<span class="heat-cell h${b}"></span>`)}<span>Ramai</span></div>
</div>`;
}

/** Ranked horizontal bars: name, a bar against the biggest, the value. */
function ranked(rows: { label: Part; value: number; text: Part; note?: Part; tip?: string }[], empty: string): Html {
  if (rows.length === 0) return emptyState(empty);
  const peak = Math.max(...rows.map((r) => r.value), 0);
  return html`<ol class="ranked">${rows.map(
    (r) => html`<li class="ranked-row"${r.tip ? new Html(` data-tip="${escapeHtml(r.tip)}" tabindex="0"`) : ""}>
      <span class="ranked-label">${r.label}${r.note ? html` <span class="ranked-note">${r.note}</span>` : ""}</span>
      <span class="ranked-value">${r.text}</span>
      <span class="ranked-track" aria-hidden="true"><span class="ranked-fill" style="--v:${num4(peak > 0 ? r.value / peak : 0)}"></span></span>
    </li>`,
  )}</ol>`;
}

/** A tiny trend line for a stat tile: the last points, the current one marked. */
function sparkline(values: number[], label: string): Html {
  if (values.length < 2) return html``;
  const peak = Math.max(...values, 0) || 1;
  const step = 100 / (values.length - 1);
  const points = values.map((v, i) => `${num4(i * step)},${num4(28 - (v / peak) * 24)}`);
  const [lx, ly] = points.at(-1)!.split(",");
  return html`<svg class="spark" viewBox="-3 -3 106 34" role="img" aria-label="${label}"><polyline points="${points.join(" ")}" /><circle cx="${lx}" cy="${ly}" r="3" /></svg>`;
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────────────────────────

function documentShell(opts: { title: string; asset: AssetUrl; bodyClass: string; body: Html }): string {
  const { asset } = opts;
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f5f4fa" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14131d" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(opts.title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="${escapeHtml(asset("jakarta.woff2"))}" as="font" type="font/woff2" crossorigin>
<style>
@font-face { font-family: "Jakarta"; src: url("${escapeHtml(asset("jakarta.woff2"))}") format("woff2"); font-weight: 200 800; font-display: swap; }
@font-face { font-family: "Bricolage"; src: url("${escapeHtml(asset("bricolage.woff2"))}") format("woff2"); font-weight: 200 800; font-display: swap; }
</style>
<link rel="stylesheet" href="${escapeHtml(asset("dashboard.css"))}">
<script src="${escapeHtml(asset("theme.js"))}"></script>
<script src="${escapeHtml(asset("dashboard.js"))}" defer></script>
</head>
<body class="${escapeHtml(opts.bodyClass)}">
${opts.body.value}
</body>
</html>`;
}

// The website's favicon: Friday's gold chat bubble with an F.
const MARK = new Html(
  '<svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M32 5C16.5 5 5 15.8 5 30c0 7.2 3 13.6 8.2 18.2L10 59l12.6-5.6c2.9.8 6.1 1.3 9.4 1.3 15.5 0 27-11 27-24.7S47.5 5 32 5Z" fill="#fac871"/><path d="M25 42V19h17v5.2H31v4.6h9.8v5H31V42h-6Z" fill="#241a5c"/></svg>',
);

function brand(name: string, sub: string): Html {
  return html`<span class="brand">${MARK}<span class="brand-name">${name}</span><span class="brand-sub">${sub}</span></span>`;
}

function themeButton(): Html {
  return html`<button class="iconbtn" type="button" data-theme-toggle aria-label="Tema: ikut sistem" title="Ganti tema">${icon("system", "theme-system")}${icon("sun", "theme-light")}${icon("moon", "theme-dark")}</button>`;
}

function topbar(s: Snapshot, ctx: ViewContext, f: Fmt): Html {
  return html`<header class="topbar">
  <div class="topbar-in">
    <a class="brand-link" href="/admin" aria-label="${s.botName} dashboard, ke atas">${brand(s.botName, "Dashboard")}</a>
    <div class="topbar-tools">
      <span class="refresh" data-refresh>
        <span class="refresh-text" data-refresh-text aria-live="polite">Diperbarui ${f.timeSec(s.generatedAt)}</span>
        <button class="iconbtn" type="button" data-refresh-now aria-label="Perbarui sekarang" title="Perbarui sekarang">${icon("refresh")}</button>
      </span>
      ${themeButton()}
      <form method="post" action="/admin/logout" class="inline-form">
        <input type="hidden" name="csrf" value="${ctx.csrf}">
        <button class="btn btn-quiet btn-small" type="submit">${icon("logout")}<span class="hide-sm">Keluar</span></button>
      </form>
    </div>
  </div>
</header>`;
}

/** 7 / 30 / 90 days. Links, so they work without the script; the script swaps the page in place instead. */
function rangeControl(ctx: ViewContext, cls: string): Html {
  return html`<div class="range ${cls}" role="group" aria-label="Periode grafik dan tabel">
      ${RANGES.map((r) => html`<a href="/admin?range=${r}" data-range-link="${r}"${r === ctx.range ? new Html(' aria-current="true"') : ""}>${r} hari</a>`)}
    </div>`;
}

function sectionNav(ctx: ViewContext): Html {
  const sections = Object.entries(SECTION_NAMES) as [Section, string][];
  return html`<nav class="secnav" aria-label="Bagian dashboard">
  <div class="secnav-in">
    <ul class="secnav-list">${sections.map(([id, name]) => html`<li><a href="#${id}" data-nav="${id}">${name}</a></li>`)}</ul>
    ${rangeControl(ctx, "range-nav")}
  </div>
</nav>`;
}

/** On phones the period sits here, above the sections it changes, instead of in the crowded sticky bar. */
function periodBar(ctx: ViewContext): Html {
  return html`<div class="period"><p class="period-label">Grafik dan tabel di bawah untuk</p>${rangeControl(ctx, "range-inline")}</div>`;
}

function sectionHead(id: Section, title: string, sub?: Part): Html {
  return html`<div class="section-head"><h2 class="section-title" id="h-${id}">${title}</h2>${sub ? html`<p class="section-sub">${sub}</p>` : ""}</div>`;
}

function section(id: Section, title: string, sub: Part, body: Part): Html {
  return html`<section class="section" id="${id}" aria-labelledby="h-${id}" data-section="${id}">${sectionHead(id, title, sub)}${body}</section>`;
}

function actionForm(ctx: ViewContext, action: string, button: Html, opts: { chat?: string; confirm?: { title: string; text: string; ok: string } } = {}): Html {
  return html`<form method="post" action="/admin/action" class="inline-form"${
    opts.confirm
      ? new Html(
          ` data-confirm-title="${escapeHtml(opts.confirm.title)}" data-confirm-text="${escapeHtml(opts.confirm.text)}" data-confirm-ok="${escapeHtml(opts.confirm.ok)}"`,
        )
      : ""
  }>
  <input type="hidden" name="csrf" value="${ctx.csrf}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="range" value="${ctx.range}">${
    opts.chat ? html`<input type="hidden" name="chat" value="${opts.chat}">` : ""
  }${button}
</form>`;
}

// ── Ringkasan ────────────────────────────────────────────────────────────────────────────────────────────────────

const LINK_FOR: Partial<Record<Attention["code"], [Section, string]>> = {
  claudeFailing: ["sistem", "Lihat log"],
  costToday: ["biaya", "Lihat biaya"],
  costPerson: ["biaya", "Lihat biaya"],
  memoryHigh: ["sistem", "Lihat sistem"],
  diskLow: ["sistem", "Lihat sistem"],
  backupStale: ["sistem", "Lihat backup"],
  remindersStuck: ["jadwal", "Lihat jadwal"],
  toolErrors: ["aktivitas", "Lihat alat"],
  loginFailures: ["keamanan", "Lihat login"],
  accessRequests: ["orang", "Lihat permintaan"],
};

function attentionWords(a: Attention, s: Snapshot, f: Fmt): { title: string; text: string } {
  switch (a.code) {
    case "whatsappDown":
      if (a.state === "loggedOut") return { title: "WhatsApp mengeluarkan Friday", text: `Sejak ${f.when(a.since)}. Nomor ${s.botName} perlu ditautkan lagi: buka log di server (linux-service.sh logs) untuk QR barunya.` };
      if (a.state === "waitingForScan") return { title: "Menunggu QR di-scan", text: `Sejak ${f.when(a.since)}. Scan QR di log server dari HP nomor ${s.botName}: WhatsApp → Perangkat tertaut.` };
      return { title: "WhatsApp terputus", text: `Sejak ${f.when(a.since)} (${f.span(s.generatedAt - a.since)}). ${s.botName} menyambung ulang sendiri; kalau lebih dari 10 menit, cek log di server.` };
    case "stopped":
      return { title: `${s.botName} sedang dihentikan`, text: "Semua chat diabaikan sampai dinyalakan lagi. Pengingat dan pesan terjadwal tetap terkirim." };
    case "claudeFailing":
      return {
        title: "Claude gagal menjawab",
        text: `${a.failures}× dalam 1 jam terakhir, terakhir ${f.ago(a.lastAt)}${a.severity === "critical" ? ", belum ada yang berhasil sejak itu" : ""}.${a.message ? ` ${a.message}` : ""}`,
      };
    case "costToday":
      return { title: `Biaya hari ini ${f.usd(a.dollars)}`, text: `Lewat batas peringatan ${f.usd(a.limit)} per hari. Hanya pemberitahuan: tidak ada yang dibatasi.` };
    case "costPerson":
      return { title: `${a.name} sudah ${f.usd(a.dollars)} hari ini`, text: `Lewat batas per orang ${f.usd(a.limit)}. Hanya pemberitahuan.` };
    case "memoryHigh":
      return { title: `Memori ${s.botName} ${f.pct(a.used / a.limit)}`, text: `${f.bytes(a.used)} dari batas ${f.bytes(a.limit)}. Kalau penuh, server me-restart ${s.botName}.` };
    case "diskLow":
      return { title: "Disk server hampir penuh", text: `Sisa ${f.bytes(a.free)} dari ${f.bytes(a.total)}.` };
    case "backupStale":
      return {
        title: a.lastAt ? `Backup terakhir ${f.ago(a.lastAt)}` : "Belum ada backup",
        text: "Backup harian mestinya jalan tiap 03.30. Cek di server: sudo /opt/friday/app/scripts/linux-service.sh backup",
      };
    case "remindersStuck":
      return { title: `${a.count} jadwal belum terkirim`, text: `Mestinya terkirim sejak ${f.when(a.oldestDueAt)}. Biasanya karena WhatsApp terputus.` };
    case "toolErrors":
      return { title: `${toolName(a.tool)} sering gagal`, text: `${a.errors} dari ${a.calls} panggilan hari ini gagal.` };
    case "loginFailures":
      return { title: `${a.count} login gagal dalam 24 jam`, text: "Kalau bukan kamu, ganti password dashboard dan cek daftar login." };
    case "accessRequests":
      return { title: `${a.count} orang minta akses`, text: "Dari tombol di website. Izinkan lewat WhatsApp dengan /add." };
  }
}

function healthPanel(s: Snapshot, ctx: ViewContext, f: Fmt): Html {
  const issues = s.attention.filter((a) => a.severity !== "info");
  const infos = s.attention.filter((a) => a.severity === "info");
  const worst = issues[0]?.severity;
  const tone: Tone = worst ?? "good";
  const title = issues.length === 0 ? (infos.length ? "Semua normal" : "Semua berjalan normal") : issues.length === 1 ? "1 hal perlu dicek" : `${issues.length} hal perlu dicek`;
  const sub = `${s.botName} menyala ${f.span(s.system.uptimeMs)}${s.system.version ? ` · versi ${s.system.version.hash}` : ""} · ${s.status.whatsapp.state === "open" ? "WhatsApp terhubung" : "WhatsApp belum terhubung"}`;
  const control = s.status.stopped
    ? actionForm(ctx, "resume", html`<button class="btn btn-primary" type="submit">${icon("play")}<span>Nyalakan lagi</span></button>`)
    : actionForm(ctx, "stop", html`<button class="btn btn-danger-quiet" type="submit">${icon("pause")}<span>Hentikan ${s.botName}</span></button>`, {
        confirm: {
          title: `Hentikan ${s.botName}?`,
          text: `${s.botName} akan diam di semua chat (pribadi dan grup), termasuk balasan titip pesan dan tugas terjadwal. Pengingat dan pesan terjadwal tetap terkirim. Kamu akan diberi tahu di WhatsApp.`,
          ok: "Hentikan",
        },
      });
  return html`<div class="health health-${tone}">
  <div class="health-head">
    <span class="health-icon" aria-hidden="true">${icon(worst ?? "ok")}</span>
    <div class="health-titles"><p class="health-title">${title}</p><p class="health-sub">${sub}</p></div>
    <div class="health-control">${control}</div>
  </div>
  ${
    s.attention.length
      ? html`<ul class="attn-list">${s.attention.map((a) => {
          const words = attentionWords(a, s, f);
          const link = LINK_FOR[a.code];
          const sev = SEVERITY[a.severity];
          return html`<li class="attn">
          ${chip(sev.label, sev.tone, icon(a.severity))}
          <div class="attn-words"><p class="attn-title">${words.title}</p><p class="attn-text">${words.text}</p></div>
          ${link ? html`<a class="attn-link" href="#${link[0]}">${link[1]}${icon("arrow")}</a>` : ""}
        </li>`;
        })}</ul>`
      : ""
  }
</div>`;
}

/** CPU load per CPU that turns the server's dot yellow, then orange. */
const LOAD_WARN = 1.5;
const LOAD_BAD = 3;

function vitals(s: Snapshot, f: Fmt): Html {
  const wa = s.status.whatsapp;
  const waWords: Record<string, [Tone, string]> = {
    open: ["good", "Terhubung"],
    connecting: ["warning", "Menyambung…"],
    closed: ["critical", "Terputus"],
    waitingForScan: ["critical", "Perlu scan QR"],
    loggedOut: ["critical", "Dikeluarkan"],
  };
  const [waTone, waLabel] = waWords[wa.state] ?? ["neutral", wa.state];
  const failing = s.attention.find((a) => a.code === "claudeFailing");
  const claudeTone: Tone = failing ? (failing.severity === "critical" ? "critical" : "serious") : s.status.lastTurnAt ? "good" : "neutral";
  const mem = s.system.memory;
  const memShare = mem.limit ? mem.rss / mem.limit : null;
  const disk = s.system.storage.disk;
  const diskUsed = disk ? 1 - disk.free / disk.total : null;
  // Load per CPU: 1 means every CPU is busy; replies slow down well before 3.
  const loadShare = s.system.host.load[0] / Math.max(1, s.system.host.cpus);
  const serverTone: Tone =
    (memShare ?? 0) >= 0.9 || (diskUsed ?? 0) >= 0.95 || loadShare >= LOAD_BAD
      ? "serious"
      : (memShare ?? 0) >= 0.8 || (diskUsed ?? 0) >= 0.9 || loadShare >= LOAD_WARN
        ? "warning"
        : "good";
  const counts = s.schedules.counts;
  const active = counts.reminder + counts.message + counts.task;
  const item = (label: string, value: Html, sub: Part, iconName: string) =>
    html`<div class="vital"><p class="vital-label">${icon(iconName)}${label}</p><p class="vital-value">${value}</p><p class="vital-sub">${sub}</p></div>`;
  return html`<div class="vitals">
  ${item("WhatsApp", dot(waTone, waLabel, wa.state === "open"), [`sejak ${f.when(wa.since)}`, wa.number ? ` · +${wa.number}` : "", wa.reconnects ? ` · ${wa.reconnects}× sambung ulang` : ""], "chat")}
  ${item(
    "Claude",
    dot(claudeTone, failing ? "Ada yang gagal" : s.status.lastTurnAt ? `Jawab ${f.ago(s.status.lastTurnAt)}` : "Belum menjawab"),
    `${modelName(s.settings.model)} · effort ${s.settings.effort}${s.settings.chatModels ? ` · ${s.settings.chatModels} chat pakai model lain` : ""}`,
    "spark",
  )}
  ${item(
    "Jadwal",
    dot(s.schedules.overdue ? "serious" : active ? "accent" : "neutral", s.status.nextScheduleAt ? `Berikutnya ${f.until(s.status.nextScheduleAt)}` : "Tidak ada jadwal"),
    `${active} aktif${s.schedules.overdue ? ` · ${s.schedules.overdue} terlambat` : ""}`,
    "calendar",
  )}
  ${item(
    "Server",
    dot(serverTone, memShare !== null ? `Memori ${f.pct(memShare)}` : `Memori ${f.bytes(mem.rss)}`),
    [diskUsed !== null ? `disk ${f.pct(diskUsed)} terpakai · ` : "", `beban ${s.system.host.load[0].toLocaleString("id-ID", { maximumFractionDigits: 2 })} / ${s.system.host.cpus} CPU`],
    "server",
  )}
</div>`;
}

function kpis(s: Snapshot, f: Fmt): Html {
  const t = s.today;
  const m = s.month;
  const recent = s.daily.slice(-14);
  const limit = s.settings.alertTotal;
  const todayStat = s.daily.at(-1);
  const prevShare = m.previous.toDate > 0 ? (m.dollars - m.previous.toDate) / m.previous.toDate : null;
  return html`<div class="kpis">
  <div class="kpi kpi-lead">
    <p class="kpi-label">Biaya hari ini</p>
    <p class="kpi-value">${f.usd(t.dollars)}</p>
    <p class="kpi-sub">≈ ${f.idr(t.dollars)} · kemarin ${f.usd(t.yesterday.dollars)}</p>
    ${
      limit > 0
        ? html`<div class="kpi-meter">${meter(t.dollars, limit, `Biaya hari ini terhadap batas peringatan ${f.usd(limit)}`, 0.8, 1)}<p class="kpi-note">${f.pct(t.dollars / limit)} dari batas peringatan ${f.usd(limit)}</p></div>`
        : ""
    }
  </div>
  <div class="kpi">
    <p class="kpi-label">Bulan ini</p>
    <p class="kpi-value">${f.usd(m.dollars)}</p>
    <p class="kpi-sub">≈ ${f.idr(m.dollars)}</p>
    <p class="kpi-note">Perkiraan akhir bulan <strong>${f.usd(m.projected)}</strong></p>
    <p class="kpi-note">${
      prevShare === null
        ? `Bulan lalu ${f.usd(m.previous.dollars)}`
        : `${prevShare >= 0 ? "▲" : "▼"} ${f.pct(Math.abs(prevShare))} dari bulan lalu di tanggal yang sama (${f.usd(m.previous.toDate)})`
    }</p>
  </div>
  <div class="kpi">
    <p class="kpi-label">Pesan dijawab hari ini</p>
    <p class="kpi-value">${f.int(t.messages)}</p>
    <p class="kpi-sub">kemarin ${f.int(t.yesterday.messages)}</p>
    ${sparkline(recent.map((d) => d.messages), `Pesan per hari, ${recent.length} hari terakhir`)}
    <p class="kpi-note">${todayStat ? `${f.int(todayStat.privateMessages)} pribadi · ${f.int(todayStat.groupMessages)} grup` : ""}${t.failed ? ` · ${t.failed} gagal` : ""}</p>
  </div>
  <div class="kpi">
    <p class="kpi-label">Waktu balas hari ini</p>
    <p class="kpi-value">${f.seconds(t.p50Ms)}</p>
    <p class="kpi-sub">median${t.p95Ms !== null ? html` · 95% di bawah <strong>${f.seconds(t.p95Ms)}</strong>` : ""}</p>
  </div>
  <div class="kpi">
    <p class="kpi-label">Orang dibantu hari ini</p>
    <p class="kpi-value">${f.int(t.people)}</p>
    <p class="kpi-sub">dari ${f.int(t.contacts)} kontak${s.guests.length ? ` · ${s.guests.length} tamu di grup (${s.range} hari)` : ""}</p>
  </div>
</div>`;
}

function overview(s: Snapshot, ctx: ViewContext, f: Fmt): Html {
  return section("ringkasan", "Ringkasan", html`Keadaan ${s.botName} saat ini · ${f.full(s.generatedAt)}`, [healthPanel(s, ctx, f), vitals(s, f), kpis(s, f)]);
}

// ── Biaya ────────────────────────────────────────────────────────────────────────────────────────────────────────

function costs(s: Snapshot, f: Fmt): Html {
  const days = s.daily;
  const total = s.costs.total;
  const busiest = days.reduce<DayStat | undefined>((best, d) => (!best || d.dollars > best.dollars ? d : best), undefined);
  const bars: Bar[] = days.map((d) => ({
    day: d.day,
    parts: [d.dollars],
    tip: [f.dayLabel(d.day), `${f.usd(d.dollars)} ≈ ${f.idr(d.dollars)}`, ...d.topPeople.map((p) => `${p.name} ${f.usd(p.dollars)}`)],
  }));
  const top = s.costs.people.slice(0, 7);
  const rest = s.costs.people.slice(7);
  const restSum = rest.reduce((a, p) => a + p.dollars, 0);
  const peopleRows = [
    ...top.map((p) => ({ label: p.name, value: p.dollars, text: f.usd(p.dollars), tip: `${p.name}\n${f.usd(p.dollars)} ≈ ${f.idr(p.dollars)}\n${total > 0 ? f.pct(p.dollars / total) : "0%"} dari total` })),
    ...(rest.length ? [{ label: `${rest.length} lainnya`, value: restSum, text: f.usd(restSum) }] : []),
  ];
  const tk = s.costs.tokens;
  const daily = dailyColumns({
    key: "cost",
    aria: `Biaya Claude per hari, ${days.length} hari terakhir. Total ${f.usd(total)}.${busiest && busiest.dollars > 0 ? ` Tertinggi ${f.usd(busiest.dollars)} pada ${f.dayLabel(busiest.day)}.` : ""}`,
    bars,
    tick: f.usdTick,
    threshold: s.settings.alertTotal > 0 ? { value: s.settings.alertTotal, label: `Batas peringatan ${f.usd(s.settings.alertTotal)}` } : undefined,
    f,
  });
  return section(
    "biaya",
    "Biaya Claude",
    "Perkiraan dari harga resmi per token, bukan tagihan. Angka pastinya ada di console.anthropic.com.",
    html`<div class="grid grid-wide">
  ${panel({
    title: "Biaya per hari",
    sub: html`<strong>${f.usd(total)}</strong> dalam ${days.length} hari · ≈ ${f.idr(total)} · rata-rata ${f.usd(total / Math.max(1, days.length))} per hari`,
    body: [
      total > 0 ? daily : emptyState("Belum ada pemakaian dalam periode ini."),
      tableView("t-cost", ["Hari", "Biaya", "Rupiah", "Pesan"], days.map((d) => [f.dayLabel(d.day), f.usd(d.dollars), f.idr(d.dollars), f.int(d.messages)])),
    ],
  })}
  ${panel({ title: "Per orang", sub: `${s.range} hari terakhir`, body: ranked(peopleRows, "Belum ada pemakaian.") })}
</div>
<div class="facts">
  <div class="fact"><p class="fact-label">Hemat berkat cache</p><p class="fact-value">${f.usd(tk.cacheSavings)}</p><p class="fact-sub">${f.pct(tk.cacheShare)} token input dibaca dari cache, jauh lebih murah</p></div>
  <div class="fact"><p class="fact-label">Token</p><p class="fact-value">${f.compact(tk.fresh + tk.cached + tk.output)}</p><p class="fact-sub">baru ${f.compact(tk.fresh)} · cache ${f.compact(tk.cached)} · balasan ${f.compact(tk.output)}</p></div>
  <div class="fact"><p class="fact-label">Pencarian web</p><p class="fact-value">${f.int(tk.webSearches)}</p><p class="fact-sub">≈ ${f.usd(tk.webSearches * 0.01)} ($10 per 1.000)</p></div>
  <div class="fact fact-models"><p class="fact-label">Per model</p>${
    s.costs.models.length
      ? html`<ul class="mini-list">${s.costs.models.map((m) => html`<li><span>${modelName(m.model)}</span><span class="num">${f.usd(m.dollars)}</span></li>`)}</ul>`
      : html`<p class="fact-sub">Belum ada.</p>`
  }</div>
</div>`,
  );
}

// ── Aktivitas ────────────────────────────────────────────────────────────────────────────────────────────────────

function activity(s: Snapshot, f: Fmt): Html {
  const days = s.daily;
  const a = s.activity;
  const bars: Bar[] = days.map((d) => ({
    day: d.day,
    parts: [d.privateMessages, d.groupMessages],
    tip: [f.dayLabel(d.day), `${f.int(d.messages)} pesan`, `${f.int(d.privateMessages)} pribadi · ${f.int(d.groupMessages)} grup`, ...(d.failed ? [`${d.failed} gagal`] : [])],
  }));
  const messages = dailyColumns({ key: "msg", aria: `Pesan dijawab per hari, ${days.length} hari terakhir, dibagi chat pribadi dan grup. Total ${f.int(a.total)}.`, bars, tick: (n) => f.int(n), integer: true, f });
  const quiet = a.quietestHour;
  const busy = a.busiestHour;
  const toolRows = a.tools.slice(0, 12).map((t) => ({
    label: toolName(t.tool),
    value: t.calls,
    text: f.int(t.calls),
    note: t.errors ? chip(`${t.errors} gagal`, t.errors * 3 >= t.calls ? "serious" : "warning") : undefined,
    tip: `${toolName(t.tool)}\n${f.int(t.calls)}× dipakai${t.errors ? `\n${t.errors} gagal` : ""}${t.avgMs ? `\nrata-rata ${f.seconds(t.avgMs)}` : ""}`,
  }));
  const hidden = a.tools.length - toolRows.length;
  return section(
    "aktivitas",
    "Aktivitas",
    html`${f.int(a.total)} pesan dijawab dalam ${s.range} hari${a.failed ? html` · <strong>${a.failed} gagal</strong>` : ""}${a.refused ? ` · ${a.refused} ditolak` : ""}`,
    html`<div class="grid grid-wide">
  ${panel({
    title: "Pesan per hari",
    sub: html`<span class="legend legend-inline"><span class="legend-item"><span class="key key-bar s1"></span>Pribadi</span><span class="legend-item"><span class="key key-bar s2"></span>Grup</span></span>`,
    body: [
      a.total > 0 ? messages : emptyState("Belum ada pesan dalam periode ini."),
      tableView("t-msg", ["Hari", "Pesan", "Pribadi", "Grup", "Gagal"], days.map((d) => [f.dayLabel(d.day), f.int(d.messages), f.int(d.privateMessages), f.int(d.groupMessages), f.int(d.failed)])),
    ],
  })}
  ${panel({
    title: "Waktu balas",
    sub: html`Median ${f.seconds(a.p50Ms)} · 95% di bawah ${f.seconds(a.p95Ms)}`,
    body: [
      latencyLines(days, f),
      tableView("t-lat", ["Hari", "Median", "95%"], days.map((d) => [f.dayLabel(d.day), f.seconds(d.p50Ms), f.seconds(d.p95Ms)])),
    ],
  })}
</div>
<div class="grid grid-wide">
  ${panel({
    title: `Kapan ${s.botName} dipakai`,
    sub:
      quiet !== null && busy !== null
        ? html`Paling ramai sekitar <strong>${hour(busy)}</strong>, paling sepi sekitar <strong>${hour(quiet)}</strong> (waktu yang pas untuk update)`
        : `Per hari dan jam, ${s.range} hari terakhir`,
    body: [
      heatmap(a.heatmap),
      tableView(
        "t-heat",
        ["Hari", ...Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"))],
        a.heatmap.map((row, d) => [WEEKDAYS_LONG[d], ...row.map((v) => f.int(v))]),
      ),
    ],
  })}
  ${panel({
    title: "Alat yang dipakai",
    sub: `Dari ${s.range} hari terakhir${hidden > 0 ? `, 12 teratas dari ${a.tools.length}` : ""}`,
    body: ranked(toolRows, "Belum ada alat yang dipakai."),
  })}
</div>`,
  );
}

// ── Orang ────────────────────────────────────────────────────────────────────────────────────────────────────────

function linkChips(p: PersonRow): Html {
  const chips: Html[] = [];
  if (p.links.google) chips.push(chip("Google", "neutral"));
  if (p.links.youtube) chips.push(chip("YouTube", "neutral"));
  if (p.links.hevy) chips.push(chip("Hevy", "neutral"));
  if (p.links.spotify) chips.push(chip("Spotify", "neutral"));
  if (p.links.shopeeShops) chips.push(chip(p.links.shopeeShops > 1 ? `Shopee ×${p.links.shopeeShops}` : "Shopee", "neutral"));
  return chips.length ? html`<span class="chips">${chips}</span>` : html`<span class="muted">–</span>`;
}

function roleChips(p: PersonRow): Html {
  const roles: string[] = [];
  if (p.can.errands) roles.push("titip pesan");
  if (p.can.onehub) roles.push("onehub");
  if (p.can.smartlife && !p.admin) roles.push("Smart Life");
  if (p.can.switchModel && !p.admin) roles.push("ganti model");
  return roles.length ? html`<span class="person-roles">${roles.join(" · ")}</span>` : html``;
}

function quotaCell(p: PersonRow, s: Snapshot, f: Fmt): Html {
  const limit = s.settings.dailyMessageLimit;
  if (p.admin || limit === 0) return html`<span class="cell-main">${f.int(p.messagesToday)}</span><span class="cell-sub">tanpa batas</span>`;
  const over = p.quotaToday > limit;
  return html`<span class="cell-main">${f.int(p.messagesToday)}</span>${meter(Math.min(p.quotaToday, limit), limit, `Kuota pesan ${p.name} hari ini`, 0.8, 1)}<span class="cell-sub${over ? " text-serious" : ""}">${f.int(Math.min(p.quotaToday, limit))}/${limit} kuota${over ? ", kena batas" : ""}</span>`;
}

function people(s: Snapshot, f: Fmt): Html {
  const rows = s.people.map(
    (p) => html`<tr>
    <th scope="row" data-value="${p.name.toLowerCase()}"><span class="person">${p.admin ? html`<span class="person-badge" title="Admin">${icon("crown")}</span>` : html`<span class="person-badge person-badge-plain">${icon("person")}</span>`}<span class="person-words"><span class="person-name">${p.name}</span><span class="person-number">+${p.number}${p.source === "added" && p.addedAt ? ` · ditambah ${f.dateShort(p.addedAt)}` : ""}</span>${roleChips(p)}</span></span></th>
    <td class="num" data-label="Hari ini" data-value="${p.messagesToday}">${quotaCell(p, s, f)}</td>
    <td class="num" data-label="${s.range} hari" data-value="${p.messagesRange}"><span class="cell-main">${f.int(p.messagesRange)}</span><span class="cell-sub">pesan</span></td>
    <td class="num" data-label="Biaya bulan ini" data-value="${num4(p.dollarsMonth)}"><span class="cell-main">${f.usd(p.dollarsMonth)}</span><span class="cell-sub">hari ini ${f.usd(p.dollarsToday)}</span></td>
    <td data-label="Terakhir aktif" data-value="${p.lastActiveAt ?? 0}">${p.lastActiveAt ? html`<span title="${f.full(p.lastActiveAt)}">${f.ago(p.lastActiveAt)}</span>` : html`<span class="muted">belum pernah</span>`}</td>
    <td data-label="Akun terhubung" data-wide>${linkChips(p)}</td>
    <td data-label="Model · gaya" data-wide>${p.ownModel || p.style ? html`<span class="chips">${p.ownModel ? chip(modelName(p.ownModel), "accent") : ""}${p.style ? chip(STYLE_NAMES[p.style] ?? p.style, "neutral") : ""}</span>` : html`<span class="muted">bawaan</span>`}</td>
  </tr>`,
  );
  const guests = s.guests.length
    ? panel({
        title: "Tamu di grup",
        sub: `Bukan kontak, tapi memakai ${s.botName} di grup dalam ${s.range} hari terakhir`,
        body: html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Nama</th><th scope="col" class="num">Pesan</th><th scope="col" class="num">Biaya</th><th scope="col">Terakhir</th></tr></thead><tbody>${s.guests.map(
          (g) => html`<tr><th scope="row"><span class="cell-main">${g.name}</span><span class="cell-sub">+${g.number}</span></th><td class="num">${f.int(g.messagesRange)}</td><td class="num">${f.usd(g.dollarsRange)}</td><td>${g.lastActiveAt ? f.ago(g.lastActiveAt) : "–"}</td></tr>`,
        )}</tbody></table></div>`,
      })
    : "";
  const requests = panel({
    title: "Permintaan akses",
    sub: `Dari tombol “Minta akses” di website. Izinkan dengan mengirim perintahnya ke ${s.botName} di WhatsApp.`,
    body: s.accessRequests.length
      ? html`<ul class="requests">${s.accessRequests.map((r) => {
          const command = `/add ${r.name} ${r.number}`;
          return html`<li class="request"><span class="request-words"><span class="cell-main">${r.name}</span><span class="cell-sub">+${r.number} · ${f.dayLabel(r.day)}</span></span><code class="request-cmd">${command}</code>${copyButton(command)}</li>`;
        })}</ul>`
      : emptyState("Tidak ada yang menunggu.", "ok"),
  });
  return section(
    "orang",
    "Orang",
    `${s.people.length} kontak · ${s.settings.dailyMessageLimit ? `kuota ${s.settings.dailyMessageLimit} pesan per orang per hari (admin bebas)` : "tanpa kuota harian"}`,
    html`<div class="panel panel-flush"><div class="tbl-wrap"><table class="tbl tbl-people tbl-stack" data-sortable>
  <thead><tr>
    <th scope="col" data-sort="text">Nama</th>
    <th scope="col" class="num" data-sort="num">Hari ini</th>
    <th scope="col" class="num" data-sort="num">${s.range} hari</th>
    <th scope="col" class="num" data-sort="num">Biaya bulan ini</th>
    <th scope="col" data-sort="num">Terakhir aktif</th>
    <th scope="col">Akun terhubung</th>
    <th scope="col">Model · gaya</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table></div></div>
<div class="grid grid-even">${requests}${guests}</div>`,
  );
}

// ── Grup ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function groupStatus(g: GroupRow, ctx: ViewContext, f: Fmt): Html {
  if (!g.inGroup) return chip("Sudah keluar", "neutral");
  if (!g.paused) return chip("Aktif", "good", icon("check"));
  const until = g.paused.until === null ? "sampai dibangunkan" : `sampai ${f.when(g.paused.until)}`;
  return html`<span class="cell-stack">${chip(`Diam ${until}`, "warning", icon("pause"))}${actionForm(
    ctx,
    "wake",
    html`<button class="btn btn-small" type="submit">${icon("bell")}<span>Bangunkan</span></button>`,
    { chat: g.chatId },
  )}</span>`;
}

function groups(s: Snapshot, ctx: ViewContext, f: Fmt): Html {
  if (s.groups.length === 0) {
    return section("grup", "Grup", "", html`<div class="panel">${emptyState(`${s.botName} belum ada di grup mana pun.`)}</div>`);
  }
  const active = s.groups.filter((g) => g.inGroup).length;
  const rows = s.groups.map(
    (g) => html`<tr${g.inGroup ? "" : new Html(' class="row-muted"')}>
    <th scope="row" data-value="${g.name.toLowerCase()}"><span class="cell-main">${g.name}</span><span class="cell-sub">${g.members !== null ? `${g.members} anggota` : "anggota tidak diketahui"}</span></th>
    <td class="num" data-label="Pesan" data-value="${g.messagesRange}"><span class="cell-main">${f.int(g.messagesRange)}</span><span class="cell-sub">hari ini ${f.int(g.messagesToday)}</span></td>
    <td data-label="Terakhir aktif" data-value="${g.lastActiveAt ?? 0}">${g.lastActiveAt ? html`<span title="${f.full(g.lastActiveAt)}">${f.ago(g.lastActiveAt)}</span>` : html`<span class="muted">belum pernah</span>`}</td>
    <td data-label="Konteks">${g.context ? chip("Baca semua", "accent", icon("eye")) : html`<span class="muted">Saat dipanggil</span>`}</td>
    <td data-label="Status" data-wide>${groupStatus(g, ctx, f)}</td>
    <td data-label="Model · gaya">${g.model || g.style ? html`<span class="chips">${g.model ? chip(modelName(g.model), "accent") : ""}${g.style ? chip(STYLE_NAMES[g.style] ?? g.style, "neutral") : ""}</span>` : html`<span class="muted">bawaan</span>`}</td>
    <td class="num" data-label="Jadwal aktif" data-value="${g.schedules}">${g.schedules ? f.int(g.schedules) : html`<span class="muted">–</span>`}</td>
  </tr>`,
  );
  return section(
    "grup",
    "Grup",
    `${active} grup aktif${s.groups.length > active ? ` · ${s.groups.length - active} sudah ditinggalkan` : ""} · pesan dihitung ${s.range} hari terakhir`,
    html`<div class="panel panel-flush"><div class="tbl-wrap"><table class="tbl tbl-stack" data-sortable>
  <thead><tr>
    <th scope="col" data-sort="text">Grup</th>
    <th scope="col" class="num" data-sort="num">Pesan</th>
    <th scope="col" data-sort="num">Terakhir aktif</th>
    <th scope="col">Konteks</th>
    <th scope="col">Status</th>
    <th scope="col">Model · gaya</th>
    <th scope="col" class="num" data-sort="num">Jadwal</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table></div></div>`,
  );
}

// ── Jadwal ───────────────────────────────────────────────────────────────────────────────────────────────────────

const KIND: Record<ScheduleRow["kind"], [label: string, tone: Tone, iconName: string]> = {
  reminder: ["Pengingat", "accent", "bell"],
  message: ["Pesan", "neutral", "chat"],
  task: ["Tugas", "info", "spark"],
};

function schedules(s: Snapshot, f: Fmt): Html {
  const c = s.schedules.counts;
  const total = c.reminder + c.message + c.task;
  const byDay = new Map<string, ScheduleRow[]>();
  for (const r of s.schedules.upcoming) {
    const day = f.localDay(r.dueAt);
    byDay.set(day, [...(byDay.get(day) ?? []), r]);
  }
  const list = s.schedules.upcoming.length
    ? html`<div class="agenda">${[...byDay.entries()].map(
        ([day, rows]) => html`<div class="agenda-day"><h4 class="agenda-date">${day < f.today ? "Terlambat" : f.dayLong(day)}</h4><ul class="agenda-list">${rows.map((r) => {
          const [label, tone, iconName] = KIND[r.kind];
          const late = r.dueAt < s.generatedAt - 10 * 60_000;
          return html`<li class="agenda-item${late ? " agenda-late" : ""}">
            <span class="agenda-time">${f.time(r.dueAt)}</span>
            <span class="agenda-main">
              <span class="agenda-meta">${chip(label, tone, icon(iconName))}${r.cron ? html`<span class="agenda-repeat" title="Berulang: ${r.cron}">${icon("repeat")}berulang</span>` : ""}${late ? chip("terlambat", "serious") : ""}</span>
              <span class="agenda-text">${r.text === null ? html`<span class="private">${icon("lock")}Pribadi milik ${r.owner}</span>` : r.text}</span>
              <span class="agenda-where">${icon(r.isGroup ? "group" : "person")}${r.where}${r.owner && r.owner !== r.where ? ` · dibuat ${r.owner}` : ""}</span>
            </span>
          </li>`;
        })}</ul></div>`,
      )}</div>`
    : emptyState("Tidak ada jadwal aktif.", "calendar");
  return section(
    "jadwal",
    "Jadwal",
    "Pengingat, pesan terjadwal, dan tugas yang akan datang. Isi jadwal pribadi orang lain tidak ditampilkan.",
    html`<div class="grid grid-wide">
  ${panel({ title: "Yang akan datang", sub: total > s.schedules.upcoming.length ? `${s.schedules.upcoming.length} terdekat dari ${total}` : `${total} jadwal aktif`, body: list })}
  ${panel({
    title: "Jumlah aktif",
    body: html`<ul class="counts">
      <li>${icon("bell")}<span>Pengingat</span><strong>${f.int(c.reminder)}</strong></li>
      <li>${icon("chat")}<span>Pesan terjadwal</span><strong>${f.int(c.message)}</strong></li>
      <li>${icon("spark")}<span>Tugas terjadwal</span><strong>${f.int(c.task)}</strong></li>
      <li class="${s.schedules.overdue ? "counts-bad" : ""}">${icon("clock")}<span>Terlambat</span><strong>${f.int(s.schedules.overdue)}</strong></li>
    </ul>
    <p class="note">Tugas terjadwal dijalankan Claude, jadi dihitung seperti pesan biasa. Jadwal yang terlambat lebih dari 1 jam (karena ${s.botName} mati) dilewati sampai waktu berikutnya; pengingat tetap dikirim.</p>`,
  })}
</div>`,
  );
}

// ── Fitur ────────────────────────────────────────────────────────────────────────────────────────────────────────

function features(s: Snapshot, f: Fmt): Html {
  const i = s.integrations;
  const r = s.range;
  const row = (name: string, on: boolean, detail: Part, extra?: Part) =>
    html`<li class="feature"><span class="feature-name">${name}</span>${on ? dot("good", "Aktif") : dot("neutral", "Mati")}<span class="feature-detail">${detail}</span>${extra ?? ""}</li>`;
  const accounts = (n: number) => (n ? `${n} akun terhubung` : "belum ada akun terhubung");
  const cloudflareFree = 90;
  const e = i.errands;
  const errandRows = e.recent.length
    ? html`<div class="tbl-wrap"><table class="tbl tbl-compact"><thead><tr><th scope="col">Untuk</th><th scope="col">Ke</th><th scope="col">Status</th><th scope="col" class="num">Balasan</th><th scope="col">Terakhir</th></tr></thead><tbody>${e.recent.map((x) => {
        const [label, tone] = ERRAND_STATUS[x.status] ?? [x.status, "neutral" as Tone];
        return html`<tr><th scope="row">${x.requester}</th><td>${x.target}</td><td>${chip(label, tone)}</td><td class="num">${f.int(x.turns)}</td><td>${f.ago(x.updatedAt)}</td></tr>`;
      })}</tbody></table></div>`
    : emptyState("Belum ada urusan.");
  const st = s.settings;
  const setting = (label: string, value: Part) => html`<div class="kv-row"><dt>${label}</dt><dd>${value}</dd></div>`;
  return section(
    "fitur",
    "Fitur dan layanan",
    "Apa yang menyala, berapa yang terhubung, dan berapa kali dipakai.",
    html`<div class="grid grid-wide">
  ${panel({
    title: "Layanan",
    body: html`<ul class="features">
      ${row(
        "Gambar",
        i.images.provider !== null,
        i.images.provider === null
          ? "Belum diatur"
          : [`${i.images.provider === "cloudflare" ? "Cloudflare, gratis" : "Gemini, berbayar per gambar"} · ${f.int(i.images.today)} hari ini · ${f.int(i.images.range)} dalam ${r} hari`],
        i.images.provider === "cloudflare"
          ? html`<span class="feature-meter">${meter(i.images.today, cloudflareFree, "Gambar hari ini terhadap kuota gratis", 0.7, 0.9)}<span class="cell-sub">kuota gratis ±${cloudflareFree}/hari, dipakai bersama voice note</span></span>`
          : "",
      )}
      ${row("Voice note", i.voice.enabled, i.voice.enabled ? `${f.int(i.voice.today)} hari ini · ${f.int(i.voice.range)} dalam ${r} hari` : "Butuh Cloudflare")}
      ${row("Google", i.google.enabled, i.google.enabled ? `${accounts(i.google.accounts)}${i.google.youtube ? ` · ${i.google.youtube} dengan YouTube` : ""}` : "Belum diatur")}
      ${row("Hevy", i.hevy.enabled, i.hevy.enabled ? accounts(i.hevy.accounts) : "Belum diatur")}
      ${row("Spotify", i.spotify.enabled, i.spotify.enabled ? `${accounts(i.spotify.accounts)} · mode development maksimal 5 orang` : "Belum diatur")}
      ${row("Shopee", i.shopee.enabled, i.shopee.enabled ? [`${i.shopee.shops ? `${i.shopee.shops} toko terhubung` : "belum ada toko"}`, i.shopee.sandbox ? " · sandbox" : ""] : "Belum diatur")}
      ${row("Smart Life", i.smartlife.enabled, i.smartlife.enabled ? `${i.smartlife.users} orang boleh mengontrol` : "Belum diatur")}
      ${row("onehub", i.onehub.enabled, i.onehub.enabled ? `${i.onehub.users} orang boleh memakai` : "Belum diatur")}
      ${row("Analisis pasar", true, `${f.int(i.market.today)} hari ini · ${f.int(i.market.range)} dalam ${r} hari`)}
      ${row("Polling", true, `${f.int(i.polls.range)} dibuat dalam ${r} hari`)}
      ${row("Workout bareng", i.hevy.enabled, `${i.groupWorkouts.active ? `${i.groupWorkouts.active} sedang berjalan · ` : ""}${f.int(i.groupWorkouts.range)} dalam ${r} hari`)}
      ${row("Konteks grup", i.groupContext.groups > 0, i.groupContext.groups ? `${i.groupContext.groups} grup membaca semua pesan` : "Tidak ada grup")}
    </ul>`,
  })}
  ${panel({
    title: "Pengaturan",
    sub: "Dari .env dan perintah admin",
    body: html`<dl class="kv">
      ${setting("Model default", modelName(st.model))}
      ${setting("Effort", st.effort)}
      ${setting("Chat dengan model sendiri", f.int(st.chatModels))}
      ${setting("Kuota per orang", st.dailyMessageLimit ? `${st.dailyMessageLimit} pesan/hari` : "tanpa batas")}
      ${setting("Akses grup", st.groupAccess === "contacts" ? "hanya kontak" : "semua anggota")}
      ${setting("Obrolan baru setelah", `${st.sessionIdleHours} jam diam atau ${f.compact(st.sessionMaxTokens)} token`)}
      ${setting("Peringatan biaya", `${st.alertTotal ? `${f.usd(st.alertTotal)}/hari` : "mati"} · ${st.alertPerson ? `${f.usd(st.alertPerson)}/orang` : "per orang mati"}`)}
      ${setting("Kurs", `${f.idr(1)} per $1`)}
      ${setting("Zona waktu", s.timezone)}
    </dl>`,
  })}
</div>
${panel({
  title: "Titip pesan ke orang lain",
  sub: e.users ? `${e.users} orang boleh · ${f.int(e.today)}/${e.dailyLimit} urusan baru hari ini · ${e.active} sedang berjalan` : "Belum ada yang diizinkan (ERRAND_USERS)",
  tools: e.users && e.dailyLimit ? html`<span class="panel-meter">${meter(e.today, e.dailyLimit, "Urusan baru hari ini terhadap batas harian", 0.7, 1)}</span>` : "",
  body: [errandRows, html`<p class="note">Isi urusan dan pesannya tidak ditampilkan di sini.</p>`],
})}`,
  );
}

// ── Sistem ───────────────────────────────────────────────────────────────────────────────────────────────────────

function gauge(label: string, value: number, max: number, text: Part, sub: Part, warnAt = 0.8, badAt = 0.9): Html {
  return html`<div class="gauge"><p class="gauge-label">${label}</p><p class="gauge-value">${text}</p>${meter(value, max, label, warnAt, badAt)}<p class="gauge-sub">${sub}</p></div>`;
}

const CONNECTION_WORDS: Record<string, [Tone, string]> = {
  connecting: ["neutral", "Menyambung"],
  waitingForScan: ["warning", "Menunggu scan QR"],
  open: ["good", "Terhubung"],
  closed: ["serious", "Terputus"],
  loggedOut: ["critical", "Dikeluarkan"],
};

function system(s: Snapshot, f: Fmt): Html {
  const sys = s.system;
  const mem = sys.memory;
  const host = sys.host;
  const disk = sys.storage.disk;
  const b = sys.backups;
  const gauges = [
    mem.limit
      ? gauge(`Memori ${s.botName}`, mem.rss, mem.limit, f.pct(mem.rss / mem.limit), `${f.bytes(mem.rss)} dari batas ${f.bytes(mem.limit)}`)
      : gauge(`Memori ${s.botName}`, mem.heapUsed, mem.heapTotal || 1, f.bytes(mem.rss), `heap ${f.bytes(mem.heapUsed)} dari ${f.bytes(mem.heapTotal)}`),
    gauge("Memori server", host.memTotal - host.memFree, host.memTotal, f.pct(1 - host.memFree / Math.max(1, host.memTotal)), `${f.bytes(host.memTotal - host.memFree)} dari ${f.bytes(host.memTotal)}`, 0.85, 0.95),
    disk
      ? gauge("Disk", disk.total - disk.free, disk.total, f.pct(1 - disk.free / Math.max(1, disk.total)), `sisa ${f.bytes(disk.free)} dari ${f.bytes(disk.total)}`, 0.9, 0.95)
      : gauge("Disk", 0, 1, "–", "tidak terbaca"),
    gauge(
      "Beban CPU",
      host.load[0],
      Math.max(1, host.cpus),
      host.load[0].toLocaleString("id-ID", { maximumFractionDigits: 2 }),
      `rata-rata 1 · 5 · 15 menit: ${host.load.map((l) => l.toLocaleString("id-ID", { maximumFractionDigits: 2 })).join(" · ")} (${host.cpus} CPU)`,
      LOAD_WARN,
      LOAD_BAD,
    ),
  ];
  const fact = (label: string, value: Part, sub?: Part) => html`<div class="kv-row"><dt>${label}</dt><dd>${value}${sub ? html`<span class="cell-sub">${sub}</span>` : ""}</dd></div>`;
  const backupText = !b.found
    ? html`<span class="text-warning">Folder tidak ditemukan</span>`
    : b.latestAt
      ? html`${f.ago(b.latestAt)} · ${f.bytes(b.latestBytes ?? 0)}`
      : html`<span class="text-warning">Belum ada</span>`;
  const connection = s.connection.length
    ? html`<ol class="timeline">${s.connection.slice(0, 15).map((e) => {
        const [tone, label] = CONNECTION_WORDS[e.state] ?? ["neutral", e.state];
        const detail = e.state === "closed" && e.detail ? DISCONNECTS[e.detail] ?? `kode ${e.detail}` : e.state === "open" && e.detail ? `+${e.detail}` : "";
        return html`<li class="timeline-item"><span class="timeline-time" title="${f.full(e.at)}">${f.when(e.at)}</span>${dot(tone, label)}${detail ? html`<span class="timeline-detail">${detail}</span>` : ""}</li>`;
      })}</ol>`
    : emptyState("Belum ada catatan.");
  const errors = s.problems.filter((p) => p.level === "error").length;
  const problems = s.problems.length
    ? html`<div class="log" data-log>
      <div class="log-tools">
        <div class="seg" role="group" aria-label="Saring log">
          <button type="button" class="seg-btn" data-log-filter="all" aria-pressed="true">Semua <span class="count">${s.problems.length}</span></button>
          <button type="button" class="seg-btn" data-log-filter="error" aria-pressed="false">Error <span class="count">${errors}</span></button>
          <button type="button" class="seg-btn" data-log-filter="warn" aria-pressed="false">Peringatan <span class="count">${s.problems.length - errors}</span></button>
        </div>
        <button class="btn btn-small btn-quiet" type="button" data-copy-log>${icon("copy")}<span data-copy-label>Salin yang tampil</span></button>
      </div>
      <ol class="log-list">${s.problems.slice(0, 100).map(
        (p) => html`<li class="log-item log-${p.level}" data-level="${p.level}" data-at="${new Date(p.at).toISOString()}"><span class="log-time" title="${f.full(p.at)}">${f.when(p.at)}</span>${chip(p.level === "error" ? "Error" : "Peringatan", p.level === "error" ? "critical" : "warning")}<code class="log-text">${p.text}</code></li>`,
      )}</ol>
    </div>`
    : emptyState(`Tidak ada error atau peringatan sejak ${s.botName} menyala.`, "ok");
  return section(
    "sistem",
    "Sistem",
    `Server, penyimpanan, dan catatan sejak ${s.botName} menyala ${f.when(sys.startedAt)}.`,
    html`<div class="gauges">${gauges}</div>
<div class="grid grid-even">
  ${panel({
    title: "Rincian",
    body: html`<dl class="kv">
      ${fact("Versi", sys.version ? html`<code>${sys.version.hash}</code> · ${sys.version.date}` : "tidak diketahui")}
      ${fact("Menyala", f.span(sys.uptimeMs), `sejak ${f.when(sys.startedAt)}`)}
      ${fact("Node.js", sys.node)}
      ${fact("Database", f.bytes(sys.storage.db))}
      ${fact("Gambar tersimpan", `${f.int(sys.storage.imagesCount)} file · ${f.bytes(sys.storage.images)}`, "dihapus otomatis setelah 30 hari")}
      ${fact("Backup terakhir", backupText, b.found ? `${b.count} backup · ${f.bytes(b.totalBytes)} · disimpan 14 hari` : b.dir)}
      ${fact("Server menyala", f.span(host.uptimeMs))}
    </dl>`,
  })}
  ${panel({ title: "Koneksi WhatsApp", sub: "Sejak menyala, terbaru di atas", body: connection })}
</div>
${panel({ title: "Error dan peringatan", sub: "Dari log, sejak menyala (hilang saat restart). Satu baris per kejadian, tanpa isi pesan.", body: problems })}`,
  );
}

// ── Keamanan ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Mozilla/5.0 (Macintosh…) … Chrome/130 Safari/537.36" → "Chrome di macOS". */
function browserOf(agent: string): string {
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /OPR\/|Opera/.test(agent)
      ? "Opera"
      : /SamsungBrowser/.test(agent)
        ? "Samsung Internet"
        : /Firefox\//.test(agent)
          ? "Firefox"
          : /Chrome\/|CriOS\//.test(agent)
            ? "Chrome"
            : /Safari\//.test(agent)
              ? "Safari"
              : /curl|wget|python|node|go-http/i.test(agent)
                ? "Skrip"
                : "Browser lain";
  const os = /iPhone|iPad|iOS/.test(agent)
    ? "iPhone/iPad"
    : /Android/.test(agent)
      ? "Android"
      : /Mac OS X|Macintosh/.test(agent)
        ? "macOS"
        : /Windows/.test(agent)
          ? "Windows"
          : /Linux/.test(agent)
            ? "Linux"
            : "";
  return os ? `${browser} di ${os}` : browser;
}

const LOGIN_RESULT: Record<string, [label: string, tone: Tone]> = {
  ok: ["Berhasil", "good"],
  wrong: ["Salah", "serious"],
  blocked: ["Diblokir", "critical"],
};

function security(s: Snapshot, ctx: ViewContext, f: Fmt): Html {
  const sec = s.security;
  const others = sec.sessions.filter((x) => !x.current).length;
  const sessions = sec.sessions.length
    ? html`<ul class="sessions">${sec.sessions.map(
        (x) => html`<li class="session${x.current ? " session-current" : ""}">
        <span class="session-icon" aria-hidden="true">${icon(/iPhone|iPad|Android|Mobile/.test(x.agent) ? "phone" : "system")}</span>
        <span class="session-words"><span class="cell-main">${browserOf(x.agent)}${x.current ? html` ${chip("Perangkat ini", "accent")}` : ""}</span><span class="cell-sub">IP ${x.ip} · masuk ${f.when(x.createdAt)} · aktif ${f.ago(x.seenAt)}</span></span>
      </li>`,
      )}</ul>`
    : emptyState("Tidak ada sesi.");
  const logins = sec.logins.length
    ? html`<div class="tbl-wrap"><table class="tbl tbl-compact"><thead><tr><th scope="col">Waktu</th><th scope="col">Hasil</th><th scope="col">IP</th><th scope="col">Browser</th></tr></thead><tbody>${sec.logins.map((l) => {
        const [label, tone] = LOGIN_RESULT[l.result] ?? [l.result, "neutral" as Tone];
        return html`<tr><th scope="row"><span title="${f.full(l.at)}">${f.when(l.at)}</span></th><td>${chip(label, tone)}</td><td><code>${l.ip}</code></td><td>${browserOf(l.agent)}</td></tr>`;
      })}</tbody></table></div>`
    : emptyState("Belum ada catatan login.");
  const command = "sudo /opt/friday/app/scripts/linux-service.sh admin";
  return section(
    "keamanan",
    "Keamanan",
    "Siapa yang sedang masuk ke dashboard ini. Setiap login juga dikabarkan ke WhatsApp admin.",
    html`<div class="grid grid-even">
  ${panel({
    title: "Sesi aktif",
    sub: `${sec.sessions.length} perangkat · keluar otomatis setelah 7 hari tidak dipakai`,
    tools: others
      ? actionForm(ctx, "signOutOthers", html`<button class="btn btn-small" type="submit">${icon("logout")}<span>Keluarkan ${others} perangkat lain</span></button>`, {
          confirm: { title: "Keluarkan perangkat lain?", text: "Semua browser lain harus login lagi. Browser ini tetap masuk.", ok: "Keluarkan" },
        })
      : "",
    body: sessions,
  })}
  ${panel({
    title: "Riwayat login",
    sub: sec.failures24h ? html`<strong class="text-serious">${sec.failures24h} gagal</strong> dalam 24 jam terakhir` : "Tidak ada yang gagal dalam 24 jam terakhir",
    body: logins,
  })}
</div>
<div class="panel panel-tip">
  <span class="tip-icon" aria-hidden="true">${icon("key")}</span>
  <div class="tip-words"><p class="tip-title">Ganti username atau password</p><p class="tip-text">Jalankan di server. Semua perangkat langsung keluar dan harus login lagi.</p><p class="tip-command"><code>${command}</code>${copyButton(command)}</p></div>
</div>`,
  );
}

// ── Exports ──────────────────────────────────────────────────────────────────────────────────────────────────────

const FLASH_TEXT: Record<Flash, string> = {
  stopped: "Friday dihentikan. Semua chat diabaikan sampai dinyalakan lagi.",
  resumed: "Friday aktif lagi di semua chat.",
  woke: "Grup itu aktif lagi.",
  signedOutOthers: "Perangkat lain sudah dikeluarkan.",
};

/** What goes inside <main id="main">; also sent alone (?partial=1) for the 30-second refresh. */
export function renderMain(s: Snapshot, ctx: ViewContext): string {
  const f = formatting(s);
  return html`<div class="sections" data-generated="${s.generatedAt}" data-range="${ctx.range}" data-updated="${f.timeSec(s.generatedAt)}">
${overview(s, ctx, f)}
${periodBar(ctx)}
${costs(s, f)}
${activity(s, f)}
${people(s, f)}
${groups(s, ctx, f)}
${schedules(s, f)}
${features(s, f)}
${system(s, f)}
${security(s, ctx, f)}
</div>`.value;
}

/** The whole dashboard page. */
export function renderDashboard(s: Snapshot, ctx: ViewContext): string {
  const f = formatting(s);
  const flash = ctx.flash ? FLASH_TEXT[ctx.flash].replace(/^Friday/, s.botName) : undefined;
  return documentShell({
    title: `Dashboard · ${s.botName}`,
    asset: ctx.asset,
    bodyClass: "app",
    body: html`<a class="skip" href="#main">Langsung ke isi</a>
${topbar(s, ctx, f)}
${sectionNav(ctx)}
<main id="main" class="main" tabindex="-1">${new Html(renderMain(s, ctx))}</main>
<footer class="foot"><p>${s.botName} · diperbarui otomatis tiap 30 detik · waktu ${s.timezone}</p></footer>
<dialog class="dialog" id="confirm-dialog" aria-labelledby="confirm-title">
  <form method="dialog" class="dialog-body">
    <h2 class="dialog-title" id="confirm-title" data-confirm-title></h2>
    <p class="dialog-text" data-confirm-text></p>
    <div class="dialog-actions"><button class="btn" value="cancel" type="submit">Batal</button><button class="btn btn-danger" value="ok" type="submit" data-confirm-ok>Ya</button></div>
  </form>
</dialog>
${flash ? html`<div class="toast" role="status" data-toast><span class="toast-icon" aria-hidden="true">${icon("check")}</span><span>${flash}</span><button class="iconbtn" type="button" data-toast-close aria-label="Tutup">${icon("x")}</button></div>` : ""}
<div class="tooltip" id="tooltip" role="tooltip" hidden></div>`,
  });
}

const LOGIN_PROBLEMS: Record<NonNullable<LoginView["problem"]>, string> = {
  wrong: "Username atau password salah.",
  blocked: "Terlalu banyak percobaan.",
  expired: "Sesi sudah berakhir. Silakan masuk lagi.",
  origin: "Permintaan ditolak demi keamanan. Muat ulang halaman ini, lalu coba lagi.",
  unconfigured: "",
};

/** The sign-in page (and, with problem "unconfigured", how to set a username and password up). */
export function renderLogin(v: LoginView): string {
  const command = "sudo /opt/friday/app/scripts/linux-service.sh admin";
  const minutes = v.retryAfterMs ? Math.max(1, Math.ceil(v.retryAfterMs / 60_000)) : 0;
  const problem = v.problem && v.problem !== "unconfigured" ? `${LOGIN_PROBLEMS[v.problem]}${v.problem === "blocked" && minutes ? ` Coba lagi dalam ${minutes} menit.` : ""}` : "";
  const body =
    v.problem === "unconfigured"
      ? html`<h1 class="login-title">Dashboard belum diaktifkan</h1>
  <p class="login-text">Buat username dan password dulu. Jalankan perintah ini di server, lalu buka halaman ini lagi:</p>
  <p class="tip-command"><code>${command}</code>${copyButton(command)}</p>
  <p class="login-foot">Password disimpan sebagai hash, tidak pernah dalam bentuk aslinya.</p>`
      : html`<h1 class="login-title">Masuk ke dashboard</h1>
  <p class="login-text">Pantau kesehatan, biaya, dan pemakaian Friday.</p>
  ${problem ? html`<p class="login-problem" role="alert">${icon(v.problem === "blocked" ? "critical" : "warning")}<span>${problem}</span></p>` : ""}
  <form class="login-form" method="post" action="/admin/login" data-login>
    <label class="field"><span class="field-label">Username</span><input class="input" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${v.username ?? ""}"${v.username ? "" : new Html(" autofocus")}></label>
    <label class="field"><span class="field-label">Password</span><span class="input-wrap"><input class="input" name="password" type="password" autocomplete="current-password" required${v.username ? new Html(" autofocus") : ""}><button class="input-btn" type="button" data-reveal aria-label="Tampilkan password" aria-pressed="false">${icon("eye")}</button></span></label>
    <button class="btn btn-primary btn-block" type="submit" data-submit><span>Masuk</span>${icon("arrow")}</button>
  </form>
  <p class="login-foot">${icon("shield")}<span>Hanya untuk pengelola. Setiap login dikabarkan ke WhatsApp admin.</span></p>`;
  return documentShell({
    title: v.problem === "unconfigured" ? "Dashboard belum diaktifkan" : "Masuk · Dashboard",
    asset: v.asset,
    bodyClass: "login",
    body: html`<main class="login-main">
  <div class="login-card">
    <div class="login-brand">${brand("Friday", "Dashboard")}${themeButton()}</div>
    ${body}
  </div>
</main>`,
  });
}

/** A plain page for 404s, refusals and errors under /admin. */
export function renderMessage(title: string, text: string, asset: AssetUrl): string {
  return documentShell({
    title,
    asset,
    bodyClass: "login",
    body: html`<main class="login-main"><div class="login-card">
  <div class="login-brand">${brand("Friday", "Dashboard")}</div>
  <h1 class="login-title">${title}</h1>
  <p class="login-text">${text}</p>
  <p><a class="btn btn-block" href="/admin">Kembali ke dashboard</a></p>
</div></main>`,
  });
}

