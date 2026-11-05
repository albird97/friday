import { ADMIN, DASHBOARD } from "./setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { checkCredentials, dashboardConfigured, limitKey, sessionFor, signInLimits, startSession } from "../src/admin/auth.js";
import { snapshot } from "../src/admin/data.js";
import { hashPassword, isPasswordHash, verifyPassword } from "../src/admin/password.js";
import { asset, blockNotices, describeAgent, handleAdmin } from "../src/admin/server.js";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { activePauses, EVERYWHERE, pause, resume } from "../src/pause.js";
import type { Outbox } from "../src/types.js";
import { startWeb } from "../src/web.js";

// The dashboard's sign-in, sessions and HTTP layer, driven over real HTTP the way nginx passes requests on. The pages
// themselves (view.ts) are tested elsewhere: here only status codes, headers, cookies, rows and WhatsApp texts count.

const ROOT = path.join(import.meta.dirname, "..");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

let sent: { chatId: string; text: string }[] = [];
const outbox: Outbox = {
  async sendText(chatId, text) {
    sent.push({ chatId, text });
  },
  async sendFile() {},
  async sendImage() {},
  async typing() {},
  chatIdFor: (n) => `${n}@s.whatsapp.net`,
};
const toAdmin = () => sent.filter((s) => s.chatId === `${ADMIN.number}@s.whatsapp.net`).map((s) => s.text);

beforeEach(() => {
  sent = [];
});

const server = http.createServer((req, res) => void handleAdmin(req, res, outbox));
server.listen(0, "127.0.0.1");
await once(server, "listening");
server.unref();
after(() => server.close());
const { port } = server.address() as AddressInfo;
const BASE = `http://127.0.0.1:${port}`;
// What a form on this host sends as its Origin behind nginx, which says X-Forwarded-Proto: https.
const ORIGIN = `https://127.0.0.1:${port}`;

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type Call = {
  method?: string;
  ip?: string;
  cookie?: string;
  /** Default: this host's own origin. null: none. */
  origin?: string | null;
  /** X-Forwarded-Proto. Default https. null: none (a direct connection). */
  proto?: string | null;
  agent?: string;
  form?: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
};

/** A request as nginx passes it on: X-Forwarded-Proto, and the visitor's address in X-Real-IP. */
function call(pathname: string, o: Call = {}): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": o.agent ?? CHROME_MAC };
  if (o.proto !== null) headers["X-Forwarded-Proto"] = o.proto ?? "https";
  if (o.origin !== null) headers.Origin = o.origin ?? ORIGIN;
  if (o.ip) headers["X-Real-IP"] = o.ip;
  if (o.cookie) headers.Cookie = o.cookie;
  if (o.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  const body = o.form ? new URLSearchParams(o.form).toString() : o.body;
  return fetch(BASE + pathname, { method: o.method ?? (body === undefined ? "GET" : "POST"), headers: { ...headers, ...o.headers }, body, redirect: "manual" });
}

/** A request with its path sent exactly as written (fetch would tidy away "..", for instance). */
function raw(target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: target }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const signIn = (ip: string, password = DASHBOARD.password, username = DASHBOARD.username, agent = CHROME_MAC) =>
  call("/admin/login", { ip, agent, form: { username, password } });

/** "__Host-friday_admin=<token>", from a Set-Cookie. */
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const tokenOf = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);

/** Signs in from ip and returns the browser's cookie with the session it stands for. */
async function signedIn(ip: string): Promise<{ cookie: string; id: string; csrf: string }> {
  const res = await signIn(ip);
  assert.equal(res.status, 303);
  const cookie = cookieOf(res);
  const session = sessionFor(tokenOf(cookie));
  assert.ok(session);
  sent = [];
  return { cookie, ...session };
}

type LoginRow = { at: number; ip: string; agent: string; result: string };
const logins = (ip: string) => db.prepare("SELECT at, ip, agent, result FROM admin_logins WHERE ip = ? ORDER BY id").all(ip) as LoginRow[];
const stopped = () => activePauses().some((p) => p.chatId === EVERYWHERE);

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "strict-transport-security": "max-age=31536000",
};

function assertSecurityHeaders(res: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(name), value, name);
  assert.equal(res.headers.get("cross-origin-resource-policy"), null, "nginx adds that one");
}

/** The attributes of every <input> on a page, whatever their order or quoting. */
function inputs(html: string): Record<string, string>[] {
  return [...html.matchAll(/<input\b[^>]*>/gi)].map(([tag]) =>
    Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4]])),
  );
}
const hasCsrfInput = (html: string, csrf: string) => inputs(html).some((i) => i.type?.toLowerCase() === "hidden" && i.name === "csrf" && i.value === csrf);

// data.ts is written alongside this file: until it lands, snapshot() is a stub that says so, and the tests that need
// a rendered dashboard wait for it.
const snapshotPending = await snapshot({ range: 30, outbox }).then(
  () => false,
  (err: unknown) => err instanceof Error && /isn't written yet/.test(err.message),
);
const needsSnapshot = { skip: snapshotPending && "snapshot() isn't written yet" };

describe("signing in to the dashboard", () => {
  it("sends a signed-out visitor to the sign-in page", async () => {
    for (const target of ["/admin", "/admin/", "/admin?range=7"]) {
      const res = await call(target);
      assert.equal(res.status, 303, target);
      assert.equal(res.headers.get("location"), "/admin/login");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assertSecurityHeaders(res);
    }
    const stale = await call("/admin", { cookie: "__Host-friday_admin=not-a-session" });
    assert.equal(stale.status, 303);
    assert.equal(stale.headers.get("location"), "/admin/login?expired=1");
    assert.equal(stale.headers.get("set-cookie"), "__Host-friday_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");

    // The 30-second refresh only learns that it has to sign in again.
    const partial = await call("/admin?partial=1");
    assert.equal(partial.status, 401);
    assert.equal(await partial.text(), "");
    assertSecurityHeaders(partial);
  });

  it("shows the sign-in page with strict security headers", async () => {
    for (const target of ["/admin/login", "/admin/login?expired=1"]) {
      const res = await call(target);
      assert.equal(res.status, 200, target);
      assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assertSecurityHeaders(res);
      assert.ok((await res.text()).length > 0);
    }
  });

  it("refuses a wrong password or username with 401, and logs each try", async () => {
    const ip = "192.0.2.10";
    const longAgent = `Mozilla/5.0 ${"x".repeat(300)}`;
    const wrongPassword = await signIn(ip, "bukan-kata-sandinya", DASHBOARD.username, longAgent);
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.headers.get("set-cookie"), null);
    assertSecurityHeaders(wrongPassword);
    assert.equal((await signIn(ip, DASHBOARD.password, "orang-lain")).status, 401);

    const rows = logins(ip);
    assert.deepEqual(rows.map((r) => r.result), ["wrong", "wrong"]);
    assert.equal(rows[0].agent, longAgent.slice(0, 200));
    assert.equal(rows[1].agent, CHROME_MAC);
    assert.ok(Math.abs(rows[0].at - Date.now()) < MINUTE);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE ip = ?").get(ip) as { n: number }).n, 0);
    assert.deepEqual(toAdmin(), [], "a single wrong try isn't worth a message");

    // X-Real-IP is only an address when it is one.
    await call("/admin/login", { ip: "bukan-ip; DROP TABLE", form: { username: DASHBOARD.username, password: "juga-salah-ya" } });
    assert.equal(logins("127.0.0.1").at(-1)?.result, "wrong");
  });

  it("refuses sign-ins that don't come from the dashboard's own page", async () => {
    const ip = "192.0.2.11";
    const form = { username: DASHBOARD.username, password: DASHBOARD.password };
    for (const origin of [null, "https://evil.test", `http://127.0.0.1:${port}`, "null"]) {
      const res = await call("/admin/login", { ip, origin, form });
      assert.equal(res.status, 403, String(origin));
      assert.equal(res.headers.get("set-cookie"), null);
    }
    // Reached directly rather than through nginx, the page is on plain http.
    assert.equal((await call("/admin/login", { ip, proto: null, form })).status, 403);
    assert.deepEqual(logins(ip), [], "nothing was tried");
    assert.deepEqual(toAdmin(), []);

    const direct = await call("/admin/login", { ip, proto: null, origin: `http://127.0.0.1:${port}`, form });
    assert.equal(direct.status, 303);
  });

  it("signs in with a strict session cookie, and tells the admin who and where", async () => {
    const ip = "203.0.113.20";
    const res = await signIn(ip, DASHBOARD.password, ` ${DASHBOARD.username.toUpperCase()} `);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin");
    assertSecurityHeaders(res);

    const [pair, ...attributes] = (res.headers.get("set-cookie") ?? "").split("; ");
    assert.match(pair, /^__Host-friday_admin=[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(attributes.sort(), ["HttpOnly", "Max-Age=2592000", "Path=/", "SameSite=Strict", "Secure"]);

    const token = tokenOf(pair);
    const row = db.prepare("SELECT * FROM admin_sessions WHERE id = ?").get(sha256(token)) as Record<string, string | number>;
    assert.equal(row.ip, ip);
    assert.equal(row.agent, CHROME_MAC);
    assert.equal(Number(row.expires_at) - Number(row.created_at), 7 * DAY);
    // Only the token's hash is kept: neither it nor the password is anywhere in the database's sign-in tables.
    const stored = JSON.stringify([db.prepare("SELECT * FROM admin_sessions").all(), db.prepare("SELECT * FROM admin_logins").all()]);
    assert.equal(stored.includes(token), false);
    assert.equal(stored.includes(DASHBOARD.password), false);
    assert.deepEqual(logins(ip).map((r) => r.result), ["ok"]);

    const texts = toAdmin();
    assert.equal(texts.length, 1);
    assert.match(texts[0], /Chrome di macOS/);
    assert.ok(texts[0].includes(`IP ${ip}`));
    assert.ok(texts[0].includes("sudo /opt/friday/app/scripts/linux-service.sh admin"));

    const again = await call("/admin/login", { cookie: pair });
    assert.equal(again.status, 303, "already signed in");
    assert.equal(again.headers.get("location"), "/admin");
  });

  it("shows the dashboard, with the session's CSRF token in its forms", needsSnapshot, async () => {
    const { cookie, csrf } = await signedIn("203.0.113.21");
    const page = await call("/admin?range=7", { cookie });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(page.headers.get("cache-control"), "no-store");
    assertSecurityHeaders(page);
    assert.ok(hasCsrfInput(await page.text(), csrf), "a hidden csrf input with the session's token");

    const partial = await call("/admin?partial=1&range=90&done=stopped", { cookie });
    assert.equal(partial.status, 200);
    assert.ok((await partial.text()).length > 0);
    assert.equal((await call("/admin/?range=abc&done=nonsense", { cookie })).status, 200);

    const head = await call("/admin", { cookie, method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  it("blocks an address after 5 wrong tries, tells the admin once, and still lets others in", async () => {
    const ip = "198.51.100.7";
    for (let i = 1; i <= 5; i++) assert.equal((await signIn(ip, `tebakan-nomor-${i}`)).status, 401, `try ${i}`);
    const alerts = () => toAdmin().filter((text) => text.includes(ip));
    assert.equal(alerts().length, 1);
    assert.match(alerts()[0], /5 kali/);
    assert.match(alerts()[0], /15 menit/);

    const blocked = await signIn(ip);
    assert.equal(blocked.status, 429, "even the right password waits");
    assert.equal(blocked.headers.get("set-cookie"), null);
    const retryAfter = Number(blocked.headers.get("retry-after"));
    assert.ok(retryAfter > 14 * 60 && retryAfter <= 15 * 60, String(retryAfter));
    assertSecurityHeaders(blocked);
    assert.equal((await signIn(ip, "tebakan-lagi")).status, 429);
    assert.equal(alerts().length, 1, "one message per block");
    // Refused tries are logged once a minute at most, so a flood can't push real sign-ins out of the history.
    assert.deepEqual(logins(ip).map((r) => r.result), ["wrong", "wrong", "wrong", "wrong", "wrong", "blocked"]);

    assert.equal((await signIn("198.51.100.8")).status, 303);
  });

  it("counts tries sent all at once one by one", async () => {
    const ip = "198.51.100.9";
    const statuses = await Promise.all(Array.from({ length: 8 }, (_, i) => signIn(ip, `serbuan-${i}`).then((res) => res.status)));
    assert.deepEqual(statuses.sort(), [401, 401, 401, 401, 401, 429, 429, 429]);
    // The block above was already reported this hour: this one waits for the hourly summary instead.
    assert.equal(toAdmin().filter((text) => text.includes(ip)).length, 0);
  });

  it("counts an IPv6 /64 as one address", async () => {
    for (let i = 1; i <= 5; i++) assert.equal((await signIn(`2001:db8:abcd:12::${i}`, `v6-${i}`)).status, 401);
    assert.equal((await signIn("2001:db8:abcd:12:ffff::9")).status, 429, "another address in the same /64 is blocked too");
    assert.equal((await signIn("2001:db8:abcd:13::1")).status, 303, "the next /64 is not");
    assert.equal(limitKey("2001:db8::1"), "2001:0db8:0000:0000::/64");
    assert.equal(limitKey("203.0.113.5"), "203.0.113.5");
  });

  it("keeps addresses that signed in before out of the everyone-block", () => {
    const limits = signInLimits();
    const now = Date.now();
    for (let i = 0; i < 30; i++) limits.failed(`192.0.2.${i}`, now);
    assert.equal(limits.allowed("198.51.100.77", now).ok, false, "a new address waits");
    assert.equal(limits.allowed("198.51.100.77", now, true).ok, true, "one that signed in before doesn't");
  });

  it("reports the first block at once and sums up the rest once an hour", () => {
    const texts: string[] = [];
    const notices = blockNotices((text) => texts.push(text));
    const block = (ip: string) => ({ scope: "ip" as const, ip, tries: 5, withinMs: 15 * MINUTE, forMs: 15 * MINUTE });
    const start = Date.now();
    notices.note(block("192.0.2.1"), start);
    notices.note(block("192.0.2.2"), start + MINUTE);
    notices.note(block("192.0.2.3"), start + 2 * MINUTE);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /192\.0\.2\.1/);
    notices.flush(start + 60 * MINUTE);
    assert.equal(texts.length, 2);
    assert.match(texts[1], /2 blokir lagi.*dari 2 IP \(terakhir 192\.0\.2\.3\)/);
  });

  it("ends the session on sign-out, but not on a forged one", async () => {
    const { cookie, id, csrf } = await signedIn("203.0.113.30");
    assert.equal((await call("/admin/logout", { cookie, form: { csrf: "tebakan" } })).status, 403);
    assert.equal((await call("/admin/logout", { cookie, form: {} })).status, 403);
    assert.equal((await call("/admin/logout", { cookie, origin: "https://evil.test", form: { csrf } })).status, 403);
    assert.ok(sessionFor(tokenOf(cookie)), "still signed in");

    const out = await call("/admin/logout", { cookie, form: { csrf } });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), "/admin/login");
    assert.equal(out.headers.get("set-cookie"), "__Host-friday_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
    assert.equal(db.prepare("SELECT id FROM admin_sessions WHERE id = ?").get(id), undefined);
    assert.equal((await call("/admin/login", { cookie })).status, 200, "the old cookie no longer signs anyone in");

    // Already signed out: the cookie is just cleared.
    const twice = await call("/admin/logout", { cookie, form: { csrf } });
    assert.equal(twice.status, 303);
    assert.match(twice.headers.get("set-cookie") ?? "", /Max-Age=0$/);
  });

  it("pauses every sign-in after 30 wrong tries from anywhere", () => {
    const limits = signInLimits();
    const t0 = Date.now();
    const blocks = Array.from({ length: 30 }, (_, i) => limits.failed(`10.0.${i}.1`, t0 + i * 1000));
    assert.deepEqual(blocks.slice(0, 29), Array(29).fill(undefined));
    assert.deepEqual(blocks[29], { scope: "everyone", ip: "10.0.29.1", tries: 30, withinMs: 15 * MINUTE, forMs: 15 * MINUTE });
    const blockedAt = t0 + 29_000;
    assert.deepEqual(limits.allowed("10.9.9.9", blockedAt + 1000), { ok: false, retryAfterMs: 15 * MINUTE - 1000 });
    assert.deepEqual(limits.allowed("10.9.9.9", blockedAt + 15 * MINUTE), { ok: true });
  });

  it("forgets wrong tries after 15 minutes, and a right one clears the address", () => {
    const limits = signInLimits();
    const ip = "10.1.0.1";
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) assert.equal(limits.failed(ip, t0 + i), undefined);
    const later = t0 + 15 * MINUTE + 10;
    assert.equal(limits.failed(ip, later), undefined, "the first four are too old to count");
    for (let i = 1; i <= 3; i++) limits.failed(ip, later + i);
    limits.succeeded(ip);
    for (let i = 4; i <= 7; i++) assert.equal(limits.failed(ip, later + i), undefined, "counting starts over");
    assert.equal(limits.failed(ip, later + 8)?.scope, "ip");
    assert.equal(limits.allowed(ip, later + 9).ok, false);
    assert.equal(limits.allowed("10.1.0.2", later + 9).ok, true, "other addresses carry on");
    assert.equal(limits.allowed(ip, later + 8 + 15 * MINUTE).ok, true);
  });

  it("is off until a username and a real password hash are set", async (t) => {
    const saved = { ADMIN_USER: config.ADMIN_USER, ADMIN_PASSWORD_HASH: config.ADMIN_PASSWORD_HASH };
    t.after(() => Object.assign(config, saved));
    const { cookie } = await signedIn("203.0.113.50");

    const offs: [string, string][] = [
      [DASHBOARD.username, ""],
      ["", saved.ADMIN_PASSWORD_HASH],
      ["  ", saved.ADMIN_PASSWORD_HASH],
      [DASHBOARD.username, DASHBOARD.password], // the password itself instead of its hash
    ];
    for (const [user, hash] of offs) {
      Object.assign(config, { ADMIN_USER: user, ADMIN_PASSWORD_HASH: hash });
      assert.equal(dashboardConfigured(), false, `${user}/${hash}`);
      assert.equal(await checkCredentials(user, DASHBOARD.password), false);
    }

    Object.assign(config, { ADMIN_USER: DASHBOARD.username, ADMIN_PASSWORD_HASH: "" });
    assert.equal((await call("/admin/login")).status, 200);
    const tried = await signIn("203.0.113.51");
    assert.equal(tried.status, 503);
    assert.equal(tried.headers.get("set-cookie"), null);
    assert.deepEqual(logins("203.0.113.51"), []);
    const page = await call("/admin", { cookie });
    assert.equal(page.status, 303, "nobody is signed in while it's off");
    assert.equal(page.headers.get("location"), "/admin/login?expired=1");
  });

  it("answers 500 when something breaks, logging only the message", async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    db.exec("ALTER TABLE admin_sessions RENAME TO admin_sessions_away");
    t.after(() => db.exec("ALTER TABLE admin_sessions_away RENAME TO admin_sessions"));
    const res = await call("/admin", { cookie: "__Host-friday_admin=whatever" });
    assert.equal(res.status, 500);
    assertSecurityHeaders(res);
    assert.doesNotMatch(await res.text(), /no such table|admin_sessions|\.ts:\d+/);
    assert.equal(errors.mock.callCount(), 1);
    assert.match(errors.mock.calls[0].arguments.join(" "), /no such table: admin_sessions/);
  });
});

describe("dashboard sessions", () => {
  it("last 7 days after their last use, written at most every 5 minutes, and never past 30 days", () => {
    const t0 = Date.now();
    const s = startSession("192.0.2.90", "test", t0);
    const row = () => db.prepare("SELECT seen_at AS seenAt, expires_at AS expiresAt FROM admin_sessions WHERE id = ?").get(s.id);
    assert.deepEqual(sessionFor(s.token, t0 + 4 * MINUTE), { id: s.id, csrf: s.csrf });
    assert.deepEqual(row(), { seenAt: t0, expiresAt: t0 + 7 * DAY }, "not written again within 5 minutes");
    sessionFor(s.token, t0 + 6 * MINUTE);
    assert.deepEqual(row(), { seenAt: t0 + 6 * MINUTE, expiresAt: t0 + 6 * MINUTE + 7 * DAY });
    assert.equal(sessionFor(s.token, t0 + 6 * MINUTE + 7 * DAY), undefined, "a week unused");

    const daily = startSession("192.0.2.90", "test", t0);
    for (let day = 1; day < 30; day++) assert.ok(sessionFor(daily.token, t0 + day * DAY), `day ${day}`);
    assert.equal(sessionFor(daily.token, t0 + 30 * DAY), undefined, "30 days after signing in");
    assert.equal(sessionFor(undefined), undefined);
    assert.equal(sessionFor(""), undefined);
  });

  it("are all signed out by a new password", async (t) => {
    const s = startSession("192.0.2.91", "test");
    const saved = config.ADMIN_PASSWORD_HASH;
    t.after(() => (config.ADMIN_PASSWORD_HASH = saved));
    config.ADMIN_PASSWORD_HASH = await hashPassword(DASHBOARD.password); // the same password, set again
    assert.equal(sessionFor(s.token), undefined);
    assert.equal(await checkCredentials(DASHBOARD.username, DASHBOARD.password), true);
  });

  it("keep at most 20, dropping the oldest", () => {
    db.prepare("DELETE FROM admin_sessions").run();
    const t0 = Date.now() - DAY;
    const all = Array.from({ length: 21 }, (_, i) => startSession("192.0.2.92", "test", t0 + i * 1000));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get() as { n: number }).n, 20);
    assert.equal(sessionFor(all[0].token), undefined);
    assert.ok(sessionFor(all[1].token));
    assert.ok(sessionFor(all[20].token));
  });
});

describe("dashboard actions", () => {
  it("stop and resume silence every chat, and tell the admin", async () => {
    resume(EVERYWHERE);
    const { cookie, csrf } = await signedIn("203.0.113.40");
    const stop = await call("/admin/action", { cookie, form: { csrf, action: "stop", range: "7" } });
    assert.equal(stop.status, 303);
    assert.equal(stop.headers.get("location"), "/admin?range=7&done=stopped#ringkasan");
    assert.deepEqual(activePauses().filter((p) => p.chatId === EVERYWHERE).map((p) => p.until), [null]);
    assert.equal(toAdmin().length, 1);
    assert.match(toAdmin()[0], /\/lanjut/);

    const twice = await call("/admin/action", { cookie, form: { csrf, action: "stop" } });
    assert.equal(twice.status, 303);
    assert.equal(toAdmin().length, 1, "already stopped: nothing new to tell");

    const resumed = await call("/admin/action", { cookie, form: { csrf, action: "resume", range: "365" } });
    assert.equal(resumed.status, 303);
    assert.equal(resumed.headers.get("location"), "/admin?range=30&done=resumed#ringkasan");
    assert.equal(stopped(), false);
    assert.equal(toAdmin().length, 2);
  });

  it("wake ends a quiet group's pause, and only a quiet group's", async (t) => {
    const group = "120363000000000009@g.us";
    pause(group, "Kongkow", Date.now() + 3600_000);
    pause(EVERYWHERE, "Semua chat", null);
    t.after(() => resume(EVERYWHERE));
    const { cookie, csrf } = await signedIn("203.0.113.41");
    for (const chat of ["120363000000000010@g.us", EVERYWHERE, ""]) {
      const res = await call("/admin/action", { cookie, form: { csrf, action: "wake", chat } });
      assert.equal(res.status, 400, chat);
    }
    assert.equal(stopped(), true, "wake never ends a /stop");

    const wake = await call("/admin/action", { cookie, form: { csrf, action: "wake", chat: group, range: "90" } });
    assert.equal(wake.status, 303);
    assert.equal(wake.headers.get("location"), "/admin?range=90&done=woke#grup");
    assert.equal(activePauses().some((p) => p.chatId === group), false);
    assert.equal(stopped(), true);
  });

  it("refuse without the session's CSRF token, from another origin, or signed out, and change nothing", async () => {
    resume(EVERYWHERE);
    const { cookie, csrf } = await signedIn("203.0.113.42");
    const forgeries: Call[] = [
      { cookie, form: { action: "stop" } },
      { cookie, form: { csrf: "salah", action: "stop" } },
      { cookie, form: { csrf: csrf.slice(0, -1), action: "stop" } },
      { cookie, form: { csrf: csrf.toUpperCase(), action: "stop" } },
      { cookie, origin: "https://evil.test", form: { csrf, action: "stop" } },
      { cookie, origin: null, form: { csrf, action: "stop" } },
      { form: { csrf, action: "stop" } },
      { cookie: "__Host-friday_admin=palsu", form: { csrf, action: "stop" } },
    ];
    for (const forgery of forgeries) {
      const res = await call("/admin/action", forgery);
      assert.equal(res.status, 403, JSON.stringify(forgery.form));
      assertSecurityHeaders(res);
    }
    assert.equal(stopped(), false);
    assert.deepEqual(toAdmin(), []);
    assert.equal((await call("/admin/action", { cookie, form: { csrf, action: "hapusSemua" } })).status, 400);
  });

  it("signOutOthers ends every other session, but not this one", async () => {
    const laptop = await signedIn("203.0.113.43");
    const phone = await signedIn("203.0.113.44");
    const res = await call("/admin/action", { cookie: laptop.cookie, form: { csrf: laptop.csrf, action: "signOutOthers", range: "90" } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin?range=90&done=signedOutOthers#keamanan");
    assert.equal(sessionFor(tokenOf(phone.cookie)), undefined);
    assert.ok(sessionFor(tokenOf(laptop.cookie)));

    const onPhone = await call("/admin", { cookie: phone.cookie });
    assert.equal(onPhone.status, 303);
    assert.equal(onPhone.headers.get("location"), "/admin/login?expired=1");
    assert.equal((await call("/admin/login", { cookie: laptop.cookie })).headers.get("location"), "/admin", "still signed in");
  });
});

describe("dashboard files and methods", () => {
  const TYPES: Record<string, string> = {
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    woff2: "font/woff2",
    txt: "text/plain; charset=utf-8",
    svg: "image/svg+xml",
  };
  const files = fs.readdirSync(path.join(ROOT, "src", "admin", "assets")).filter((name) => /^[a-z0-9-]+\.(css|js|woff2|txt|svg)$/.test(name));

  it("serves each file with its type, cached for good while the version matches", async () => {
    assert.ok(files.length > 0);
    for (const name of files) {
      const url = asset(name);
      const [pathname, query] = url.split("?");
      assert.equal(pathname, `/admin/assets/${name}`);
      assert.match(query, /^v=[0-9a-f]{10}$/);

      const res = await call(url, { origin: null });
      assert.equal(res.status, 200, name);
      assert.equal(res.headers.get("content-type"), TYPES[path.extname(name).slice(1)]);
      assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
      assertSecurityHeaders(res);
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(query, `v=${sha256(body).slice(0, 10)}`, "the version is the content's hash");
      assert.equal(res.headers.get("content-length"), String(body.length));

      for (const unversioned of [pathname, `${pathname}?v=0000000000`]) {
        const again = await call(unversioned, { origin: null });
        assert.equal(again.status, 200);
        assert.equal(again.headers.get("cache-control"), "no-cache", unversioned);
        const revalidated = await call(unversioned, { origin: null, headers: { "If-None-Match": again.headers.get("etag") ?? "" } });
        assert.equal(revalidated.status, 304);
      }
    }
  });

  it("serves nothing else from there", async () => {
    const targets = [
      "/admin/assets/",
      "/admin/assets/nope.css",
      "/admin/assets/DASHBOARD.CSS",
      "/admin/assets/dashboard.css/",
      "/admin/assets/.env",
      "/admin/assets/../server.ts",
      "/admin/assets/../../db.ts",
      "/admin/assets/..%2Fserver.ts",
      "/admin/assets/%2e%2e/server.ts",
      "/admin/assets/%2e%2e%2fserver.ts",
      "/admin/assets/..%5cserver.ts",
      "/admin/assets/..\\server.ts",
      "/admin/assets/%252e%252e%252fserver.ts",
      "/admin/assets/....//server.ts",
      "/admin/assets/dashboard.css%00.txt",
    ];
    for (const target of targets) {
      const res = await raw(target);
      assert.equal(res.status, 404, target);
      assert.doesNotMatch(res.body, /^import |\bexport (function|const)/m, target);
    }
    assert.equal(asset("not-there.css"), "/admin/assets/not-there.css");
  });

  it("answers HEAD like GET, without the body", async () => {
    const get = await call("/admin/login");
    const head = await call("/admin/login", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), get.headers.get("content-length"));
    assert.equal(await head.text(), "");
    assertSecurityHeaders(head);

    const file = await call(asset(files[0]), { method: "HEAD" });
    assert.equal(file.status, 200);
    assert.equal(await file.text(), "");
  });

  it("refuses other methods, other paths, and bodies that are too big or not a form", async () => {
    for (const [method, target] of [
      ["PUT", "/admin"],
      ["DELETE", "/admin/login"],
      ["PATCH", "/admin/action"],
      ["OPTIONS", "/admin"],
      ["POST", "/admin"],
      ["GET", "/admin/logout"],
      ["GET", "/admin/action"],
      ["POST", asset(files[0])],
    ]) {
      const res = await call(target, { method, ...(method === "POST" && { form: {} }) });
      assert.equal(res.status, 405, `${method} ${target}`);
      assert.ok(res.headers.get("allow"));
      assertSecurityHeaders(res);
    }
    for (const target of ["/admin/nope", "/admin//login", "/admin/login/"]) assert.equal((await call(target)).status, 404, target);

    const big = await call("/admin/login", { form: { username: DASHBOARD.username, password: "x".repeat(9000) } });
    assert.equal(big.status, 413);
    const json = await call("/admin/login", { body: JSON.stringify(DASHBOARD), headers: { "Content-Type": "application/json" } });
    assert.equal(json.status, 415);
    assert.deepEqual(logins("127.0.0.1").filter((r) => r.result === "ok"), [], "neither counted as a sign-in");
  });
});

describe("Friday's web server", () => {
  it("hands everything under /admin to the dashboard, and keeps its other pages as they were", async (t) => {
    const saved = config.WEB_PORT;
    t.after(() => (config.WEB_PORT = saved));
    config.WEB_PORT = 0; // any free port
    const web = startWeb(outbox);
    t.after(() => web.close());
    await once(web, "listening");
    const at = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;

    const admin = await fetch(`${at}/admin`, { redirect: "manual" });
    assert.equal(admin.status, 303);
    assert.equal(admin.headers.get("location"), "/admin/login");
    assertSecurityHeaders(admin);
    assert.equal((await fetch(`${at}/admin/login`, { method: "HEAD" })).headers.get("x-frame-options"), "DENY");

    const privacy = await fetch(`${at}/privacy`);
    assert.equal(privacy.status, 200);
    assert.equal(privacy.headers.get("x-frame-options"), null, "the other pages keep their own headers");
    assert.equal((await fetch(`${at}/administrator`)).status, 404);
  });
});

describe("browser names for the sign-in message", () => {
  it("are short and readable", () => {
    const agents: [string, string][] = [
      [CHROME_MAC, "Chrome di macOS"],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", "Safari di iPhone"],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1", "Chrome di iPhone"],
      ["Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36", "Samsung Internet di Android"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0", "Edge di Windows"],
      ["Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox di Linux"],
      ["curl/8.7.1", "browser tak dikenal"],
      ["", "browser tak dikenal"],
    ];
    for (const [agent, name] of agents) assert.equal(describeAgent(agent), name, agent);
  });
});

describe("dashboard password hashes", () => {
  it("round-trip, with a fresh salt each time", async () => {
    const hash = await hashPassword("kata sandi yang panjang");
    assert.match(hash, /^scrypt:16384:8:1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/);
    assert.equal(isPasswordHash(hash), true);
    assert.equal(await verifyPassword("kata sandi yang panjang", hash), true);
    assert.equal(await verifyPassword("kata sandi yang panjanG", hash), false);
    assert.equal(await verifyPassword("", hash), false);
    assert.notEqual(await hashPassword("kata sandi yang panjang"), hash);
    // é typed as one character or as e + accent is the same password.
    assert.equal(await verifyPassword("kopi-café-pagi", await hashPassword("kopi-café-pagi")), true);
  });

  it("treat anything malformed as no match, without throwing", async () => {
    const good = config.ADMIN_PASSWORD_HASH;
    const [, , , , salt, key] = good.split(":");
    const withCost = (cost: string) => `scrypt:${cost}:${salt}:${key}`;
    const malformed = [
      "",
      "scrypt",
      DASHBOARD.password,
      ` ${good}`,
      `bcrypt:16384:8:1:${salt}:${key}`,
      `scrypt:16384:8:1:${salt}`,
      `${good}:extra`,
      withCost("16383:8:1"), // N not a power of two
      withCost("1024:8:1"), // too little work
      withCost("1048576:8:1"), // a gigabyte of memory per try
      withCost("16384:0:1"),
      withCost("16384:64:1"),
      withCost("16384:8:0"),
      withCost("16384:8:99"),
      withCost("0x4000:8:1"),
      withCost("16384.0:8:1"),
      `scrypt:16384:8:1:${salt}:${key.slice(0, -2)}`,
      `scrypt:16384:8:1:abc:${key}`,
      `scrypt:16384:8:1:${salt}:${key.slice(0, -1)}!`,
      `scrypt:16384:8:1:${salt}=:${key}`,
    ];
    for (const stored of malformed) {
      assert.equal(isPasswordHash(stored), false, stored);
      assert.equal(await verifyPassword(DASHBOARD.password, stored), false, stored);
    }
    assert.equal(await verifyPassword(DASHBOARD.password, good), true);
  });
});

describe("the password command behind linux-service.sh admin", () => {
  // As the script runs it: from the app folder, the password on stdin, and none of Friday's settings around.
  const hashFrom = (input: string) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/admin/password.ts"], { cwd: ROOT, input, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });

  it("prints only the hash of the password it reads", async () => {
    const result = hashFrom("kata-sandi-baru-yang-panjang\n");
    assert.equal(result.status, 0, result.stderr);
    const hash = result.stdout.trim();
    assert.equal(isPasswordHash(hash), true);
    assert.equal(result.stdout, `${hash}\n`);
    assert.equal(await verifyPassword("kata-sandi-baru-yang-panjang", hash), true, "one trailing newline is dropped");
  });

  it("refuses a password under 10 characters", () => {
    for (const input of ["", "\n", "123456789"]) {
      const result = hashFrom(input);
      assert.equal(result.status, 1, JSON.stringify(input));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /at least 10 characters/);
    }
    assert.equal(hashFrom("1234567890").status, 0);
  });
});
