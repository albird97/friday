import { createHash } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import net from "node:net";
import path from "node:path";
import { config } from "../config.js";
import { activePauses, EVERYWHERE, pause, resume } from "../pause.js";
import { formatDateTime } from "../time.js";
import type { Outbox } from "../types.js";
import { dashboardConfigured, endOtherSessions, endSession, sameSecret, SESSION_MAX_MS, sessionFor, signIn, type Block, type Session } from "./auth.js";
import { snapshot } from "./data.js";
import { ACTIONS, FLASHES, RANGES, type AdminAction, type Flash, type LoginView, type RangeDays, type Section, type ViewContext } from "./types.js";
import { renderDashboard, renderLogin, renderMain, renderMessage } from "./view.js";

// The dashboard's requests (PUBLIC_URL/admin, through nginx): sign-in, sessions, the few emergency actions and the
// dashboard's own files. Friday sends every security header itself; nginx adds only Cross-Origin-Resource-Policy.

export const isAdminPath = (pathname: string) => pathname === "/admin" || pathname.startsWith("/admin/");

// ── Files ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const ASSETS_DIR = path.join(import.meta.dirname, "assets");
const ASSET_NAME = /^[a-z0-9-]+\.(css|js|woff2|txt|svg)$/;
const ASSET_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
};

type Asset = { body: Buffer; type: string; version: string };

// Read once at startup. A file's version is a hash of its content, so browsers can keep it until it changes.
function loadAssets(): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  try {
    for (const entry of fs.readdirSync(ASSETS_DIR, { withFileTypes: true })) {
      const extension = ASSET_NAME.exec(entry.name)?.[1];
      if (!extension || !entry.isFile()) continue;
      const body = fs.readFileSync(path.join(ASSETS_DIR, entry.name));
      assets.set(entry.name, { body, type: ASSET_TYPES[extension], version: createHash("sha256").update(body).digest("hex").slice(0, 10) });
    }
  } catch (err) {
    // A dashboard without its styles is better than Friday not starting.
    console.warn("Couldn't read the dashboard's files:", err instanceof Error ? err.message : err);
  }
  return assets;
}

const assets = loadAssets();

/** asset("dashboard.css") → "/admin/assets/dashboard.css?v=<hash>": cached for good, refetched when it changes. */
export function asset(file: string): string {
  const version = assets.get(file)?.version;
  return `/admin/assets/${file}${version ? `?v=${version}` : ""}`;
}

// ── Replies ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Reply = { status: number; headers?: Record<string, string>; body?: string | Buffer };

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const NO_STORE = { "Cache-Control": "no-store" };

const html = (status: number, body: string, headers: Record<string, string> = {}): Reply => ({
  status,
  headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE, ...headers },
  body,
});
const message = (status: number, title: string, text: string, headers?: Record<string, string>) => html(status, renderMessage(title, text, asset), headers);
const login = (status: number, view: Omit<LoginView, "asset"> = {}, headers?: Record<string, string>) => html(status, renderLogin({ ...view, asset }), headers);
const redirect = (location: string, headers: Record<string, string> = {}): Reply => ({ status: 303, headers: { Location: location, ...NO_STORE, ...headers } });

const notFound = () => message(404, "Halaman tidak ditemukan", "Alamat ini tidak ada di dashboard.");
const notAllowed = (allow: string) => message(405, "Tidak didukung", "Halaman ini tidak bisa dibuka dengan cara itu.", { Allow: allow });
const forbidden = () => message(403, "Tidak diizinkan", "Sesinya sudah habis, atau halamannya sudah lama terbuka. Muat ulang dashboard, lalu coba lagi.");

/** Thrown to answer at once with a reply that isn't an error worth logging (a body that's too big, say). */
class Answer extends Error {
  constructor(readonly reply: Reply) {
    super(`HTTP ${reply.status}`);
  }
}

function failure(err: unknown): Reply {
  console.error("Dashboard request failed:", err instanceof Error ? err.message : "unknown error");
  try {
    return message(500, "Terjadi kesalahan", "Coba muat ulang halaman ini sebentar lagi.");
  } catch {
    return { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE }, body: "Terjadi kesalahan." };
  }
}

function write(req: http.IncomingMessage, res: http.ServerResponse, reply: Reply): void {
  const body = reply.body ?? "";
  const length = reply.status === 304 ? {} : { "Content-Length": String(Buffer.byteLength(body)) };
  res.writeHead(reply.status, { ...SECURITY_HEADERS, ...length, ...reply.headers });
  res.end(req.method === "HEAD" || reply.status === 304 ? undefined : body);
}

// ── Who is asking ─────────────────────────────────────────────────────────────────────────────────────────────────

/** nginx passes the visitor's address in X-Real-IP; anyone connecting directly is who the socket says. */
function clientIp(req: http.IncomingMessage): string {
  const socket = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
  const forwarded = String(req.headers["x-real-ip"] ?? "").trim();
  const viaNginx = socket === "::1" || socket.startsWith("127.");
  return viaNginx && net.isIP(forwarded) ? forwarded : socket;
}

/** A form must come from the dashboard's own pages: a second guard against CSRF, besides SameSite=Strict cookies. */
function sameOrigin(req: http.IncomingMessage): boolean {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || "http";
  const host = req.headers.host;
  return host !== undefined && req.headers.origin === `${proto}://${host}`;
}

const COOKIE = "__Host-friday_admin";
const sessionCookie = (token: string) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_MS / 1000}`;
const CLEAR_COOKIE = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

function cookieToken(req: http.IncomingMessage): string | undefined {
  for (const pair of (req.headers.cookie ?? "").split(";")) {
    const [name, value] = pair.trim().split("=", 2);
    if (name === COOKIE && value) return value;
  }
  return undefined;
}

const signedIn = (req: http.IncomingMessage) => sessionFor(cookieToken(req));

const MAX_BODY = 8 * 1024;

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") throw new Answer(message(415, "Tidak didukung", "Kirim lewat formulir di dashboard."));
  const tooBig = () => new Answer(message(413, "Terlalu panjang", "Isian formulirnya terlalu panjang."));
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) throw tooBig();
  // Read to the end even past the limit: leaving the loop early destroys the request, and the answer with it.
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
  }
  if (size > MAX_BODY) throw tooBig();
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** The form of a signed-in post from the dashboard itself (same origin, the session's CSRF token), else undefined. */
async function trustedForm(req: http.IncomingMessage, session: Session): Promise<URLSearchParams | undefined> {
  if (!sameOrigin(req)) return undefined;
  const form = await readForm(req);
  return sameSecret(form.get("csrf") ?? "", session.csrf) ? form : undefined;
}

// ── Telling the admin ─────────────────────────────────────────────────────────────────────────────────────────────

/** Best-effort: no request waits on WhatsApp, or fails because it's down. */
function tellAdmin(outbox: Outbox, text: string): void {
  const admin = config.contacts[0];
  if (!admin) return;
  void Promise.resolve()
    .then(() => outbox.sendText(outbox.chatIdFor(admin.number), text))
    .catch((err: unknown) => console.warn("Couldn't tell the admin about the dashboard:", err instanceof Error ? err.message : err));
}

const BROWSERS: [RegExp, string][] = [
  [/Edg(A|iOS)?\//, "Edge"],
  [/OPR\/|OPT\//, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Macintosh|Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];
const firstMatch = (list: [RegExp, string][], agent: string) => list.find(([pattern]) => pattern.test(agent))?.[1];

/** "Chrome di macOS": enough to recognise one's own browser. */
export function describeAgent(agent: string): string {
  const browser = firstMatch(BROWSERS, agent) ?? "browser tak dikenal";
  const system = firstMatch(SYSTEMS, agent);
  return system ? `${browser} di ${system}` : browser;
}

const NEW_PASSWORD = "```sudo /opt/friday/app/scripts/linux-service.sh admin```";
const minutes = (ms: number) => Math.round(ms / 60_000);

function signedInText(ip: string, agent: string): string {
  return [
    `🔐 Ada yang masuk ke dashboard ${config.BOT_NAME}: ${formatDateTime(new Date())}, ${describeAgent(agent)}, IP ${ip}.`,
    `Kalau itu bukan kamu, ganti kata sandinya di server dengan ${NEW_PASSWORD}, yang sekaligus mengeluarkan semua browser.`,
  ].join("\n");
}

function blockedText(block: Block): string {
  const tries = `${block.tries} kali gagal masuk ke dashboard dalam ${minutes(block.withinMs)} menit`;
  return block.scope === "ip"
    ? `🚫 ${tries} dari IP ${block.ip}, jadi IP itu diblokir ${minutes(block.forMs)} menit.`
    : `🚫 ${tries} dari berbagai IP (terakhir ${block.ip}), jadi semua percobaan masuk dihentikan ${minutes(block.forMs)} menit, termasuk dari kamu.`;
}

// ── Pages and actions ─────────────────────────────────────────────────────────────────────────────────────────────

type Visit = { req: http.IncomingMessage; url: URL; outbox: Outbox; ip: string; agent: string };
type Handler = (visit: Visit) => Reply | Promise<Reply>;

const rangeOf = (value: string | null): RangeDays => RANGES.find((range) => String(range) === value) ?? 30;

async function dashboard({ req, url, outbox }: Visit): Promise<Reply> {
  const partial = url.searchParams.get("partial") === "1";
  const session = signedIn(req);
  if (!session) {
    // The 30-second refresh only needs to know; a stale cookie is cleared on the way to signing in again.
    if (partial) return { status: 401, headers: NO_STORE };
    return cookieToken(req) ? redirect("/admin/login?expired=1", { "Set-Cookie": CLEAR_COOKIE }) : redirect("/admin/login");
  }
  const range = rangeOf(url.searchParams.get("range"));
  const done = url.searchParams.get("done");
  const ctx: ViewContext = { csrf: session.csrf, range, flash: FLASHES.find((flash) => flash === done), asset };
  const s = await snapshot({ range, currentSession: session.id, outbox });
  return html(200, partial ? renderMain(s, ctx) : renderDashboard(s, ctx));
}

function loginPage({ req, url }: Visit): Reply {
  if (signedIn(req)) return redirect("/admin");
  if (!dashboardConfigured()) return login(200, { problem: "unconfigured" });
  return login(200, url.searchParams.get("expired") === "1" ? { problem: "expired" } : {});
}

async function signInForm({ req, outbox, ip, agent }: Visit): Promise<Reply> {
  if (!dashboardConfigured()) return login(503, { problem: "unconfigured" });
  if (!sameOrigin(req)) return login(403, { problem: "origin" });
  const form = await readForm(req);
  const username = (form.get("username") ?? "").slice(0, 100);
  const attempt = await signIn({ username, password: form.get("password") ?? "", ip, agent });
  if (attempt.result === "blocked") {
    const retryAfter = String(Math.ceil(attempt.retryAfterMs / 1000));
    return login(429, { problem: "blocked", retryAfterMs: attempt.retryAfterMs, username }, { "Retry-After": retryAfter });
  }
  if (attempt.result === "wrong") {
    if (attempt.block) tellAdmin(outbox, blockedText(attempt.block));
    return login(401, { problem: "wrong", username });
  }
  tellAdmin(outbox, signedInText(ip, agent));
  return redirect("/admin", { "Set-Cookie": sessionCookie(attempt.session.token) });
}

async function logout({ req }: Visit): Promise<Reply> {
  const session = signedIn(req);
  if (session) {
    if (!(await trustedForm(req, session))) return forbidden();
    endSession(session.id);
  }
  return redirect("/admin/login", { "Set-Cookie": CLEAR_COOKIE });
}

const AFTER: Record<AdminAction, { flash: Flash; anchor: Section }> = {
  stop: { flash: "stopped", anchor: "ringkasan" },
  resume: { flash: "resumed", anchor: "ringkasan" },
  wake: { flash: "woke", anchor: "grup" },
  signOutOthers: { flash: "signedOutOthers", anchor: "keamanan" },
};

const stoppedEverywhere = () => activePauses().some((p) => p.chatId === EVERYWHERE);

async function action({ req, outbox }: Visit): Promise<Reply> {
  const session = signedIn(req);
  const form = session && (await trustedForm(req, session));
  if (!session || !form) return forbidden();
  const chosen = ACTIONS.find((name) => name === form.get("action"));
  if (!chosen) return message(400, "Aksi tidak dikenal", "Muat ulang dashboard, lalu coba lagi.");
  const bot = config.BOT_NAME;
  switch (chosen) {
    case "stop":
      if (stoppedEverywhere()) break;
      pause(EVERYWHERE, "Semua chat", null);
      tellAdmin(
        outbox,
        `⏸️ ${bot} dihentikan dari dashboard: berhenti membalas di semua chat (pribadi dan grup). Pengingat dan pesan terjadwal tetap terkirim.\nKirim /lanjut, atau nyalakan lagi dari dashboard.`,
      );
      break;
    case "resume":
      if (resume(EVERYWHERE)) tellAdmin(outbox, `▶️ ${bot} aktif lagi di semua chat (dinyalakan dari dashboard).`);
      break;
    case "wake": {
      const chat = form.get("chat") ?? "";
      if (chat === EVERYWHERE || !activePauses().some((p) => p.chatId === chat)) {
        return message(400, "Grup tidak ditemukan", "Grup itu sedang tidak didiamkan. Muat ulang dashboard untuk melihat keadaannya sekarang.");
      }
      resume(chat);
      break;
    }
    case "signOutOthers":
      endOtherSessions(session.id);
      break;
  }
  const { flash, anchor } = AFTER[chosen];
  return redirect(`/admin?range=${rangeOf(form.get("range"))}&done=${flash}#${anchor}`);
}

function serveAsset({ req, url }: Visit): Reply {
  const name = url.pathname.slice("/admin/assets/".length);
  const file = ASSET_NAME.test(name) ? assets.get(name) : undefined;
  if (!file) return notFound();
  const etag = `"${file.version}"`;
  const cache = url.searchParams.get("v") === file.version ? "public, max-age=31536000, immutable" : "no-cache";
  if (req.headers["if-none-match"] === etag) return { status: 304, headers: { ETag: etag, "Cache-Control": cache } };
  return { status: 200, headers: { "Content-Type": file.type, ETag: etag, "Cache-Control": cache }, body: file.body };
}

type Handlers = { GET?: Handler; POST?: Handler };

const ROUTES = new Map<string, Handlers>([
  ["/admin", { GET: dashboard }],
  ["/admin/", { GET: dashboard }],
  ["/admin/login", { GET: loginPage, POST: signInForm }],
  ["/admin/logout", { POST: logout }],
  ["/admin/action", { POST: action }],
]);
const ASSET_ROUTE: Handlers = { GET: serveAsset };

async function route(req: http.IncomingMessage, outbox: Outbox): Promise<Reply> {
  const url = URL.parse(req.url ?? "/", "http://localhost");
  if (!url || !isAdminPath(url.pathname)) return notFound();
  const method = req.method === "HEAD" ? "GET" : req.method;
  if (method !== "GET" && method !== "POST") return notAllowed("GET, HEAD, POST");
  const handlers = url.pathname.startsWith("/admin/assets/") ? ASSET_ROUTE : ROUTES.get(url.pathname);
  if (!handlers) return notFound();
  const handler = handlers[method];
  if (!handler) return notAllowed(handlers.GET ? "GET, HEAD" : "POST");
  return handler({ req, url, outbox, ip: clientIp(req), agent: String(req.headers["user-agent"] ?? "") });
}

/** Answers a request for /admin or anything under it. Never throws. */
export async function handleAdmin(req: http.IncomingMessage, res: http.ServerResponse, outbox: Outbox): Promise<void> {
  const reply = await route(req, outbox).catch((err: unknown) => (err instanceof Answer ? err.reply : failure(err)));
  try {
    write(req, res, reply);
  } catch (err) {
    console.error("Dashboard response failed:", err instanceof Error ? err.message : "unknown error");
    res.destroy();
  }
}
