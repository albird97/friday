import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { config } from "../config.js";
import { db } from "../db.js";
import { isPasswordHash, verifyPassword } from "./password.js";

// Signing in to the dashboard: one username and password from .env (the password only as a scrypt hash), limits on
// wrong tries, and sessions in the database. The cookie holds a random token; the database only the token's SHA-256.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export function dashboardConfigured(): boolean {
  return config.ADMIN_USER.trim() !== "" && isPasswordHash(config.ADMIN_PASSWORD_HASH);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest();

/** Constant-time comparison, whatever the lengths. */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** Always checks the password, even for a wrong username, so the time taken doesn't tell which of the two was wrong. */
export async function checkCredentials(username: string, password: string): Promise<boolean> {
  const passwordOk = await verifyPassword(password, config.ADMIN_PASSWORD_HASH);
  const usernameOk = sameSecret(username.trim().toLowerCase(), config.ADMIN_USER.trim().toLowerCase());
  return dashboardConfigured() && usernameOk && passwordOk;
}

// Wrong tries, in memory (a restart forgets them). 5 from one address within 15 minutes block that address for 15
// minutes; 30 from anywhere block every sign-in, so spreading the guesses over many addresses doesn't help. Addresses
// that signed in before are exempt from that everyone-block (not from their own), so a crowd of strangers can't keep
// the admin out of the dashboard from home.
const WINDOW_MS = 15 * MINUTE;
const BLOCK_MS = 15 * MINUTE;
const TRIES_PER_IP = 5;
const TRIES_IN_ALL = 30;

/**
 * Who a limit counts against: the address itself, or for IPv6 its /64, which one household or one server usually gets
 * whole (so its many addresses count as one).
 */
export function limitKey(ip: string): string {
  if (!net.isIPv6(ip) || ip.includes(".")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const front = head ? head.split(":") : [];
  const back = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups
    .slice(0, 4)
    .map((g) => g.padStart(4, "0"))
    .join(":")}::/64`;
}

type Tries = { at: number[]; blockedUntil: number };
/** A block that a wrong try just started: who it covers, after how many tries in how long, and for how long. */
export type Block = { scope: "ip" | "everyone"; ip: string; tries: number; withinMs: number; forMs: number };
export type Allowed = { ok: true } | { ok: false; retryAfterMs: number };

/** The process keeps one (below); tests make their own. */
export function signInLimits() {
  const byIp = new Map<string, Tries>();
  const everyone: Tries = { at: [], blockedUntil: 0 };

  const recent = (tries: Tries, now: number) => (tries.at = tries.at.filter((at) => at > now - WINDOW_MS));

  function block(tries: Tries, scope: Block["scope"], ip: string, now: number): Block {
    const started: Block = { scope, ip, tries: tries.at.length, withinMs: WINDOW_MS, forMs: BLOCK_MS };
    tries.blockedUntil = now + BLOCK_MS;
    tries.at = [];
    return started;
  }

  /** trusted: this address signed in successfully before, so the everyone-block doesn't apply to it. */
  function allowed(ip: string, now = Date.now(), trusted = false): Allowed {
    const until = Math.max(trusted ? 0 : everyone.blockedUntil, byIp.get(limitKey(ip))?.blockedUntil ?? 0);
    return until > now ? { ok: false, retryAfterMs: until - now } : { ok: true };
  }

  /** Counts a wrong try. Returns the block it started, if it started one. */
  function failed(ip: string, now = Date.now()): Block | undefined {
    for (const [other, tries] of byIp) if (recent(tries, now).length === 0 && tries.blockedUntil <= now) byIp.delete(other);
    const key = limitKey(ip);
    const mine = byIp.get(key) ?? { at: [], blockedUntil: 0 };
    byIp.set(key, mine);
    recent(everyone, now);
    mine.at.push(now);
    everyone.at.push(now);
    if (everyone.at.length >= TRIES_IN_ALL) return block(everyone, "everyone", ip, now);
    if (mine.at.length >= TRIES_PER_IP) return block(mine, "ip", ip, now);
    return undefined;
  }

  function succeeded(ip: string): void {
    byIp.delete(limitKey(ip));
  }

  return { allowed, failed, succeeded };
}

const limits = signInLimits();
export const loginAllowed = limits.allowed;
export const noteFailure = limits.failed;
export const noteSuccess = limits.succeeded;

export type LoginResult = "ok" | "wrong" | "blocked";
const LOGINS_KEPT = 500; // as pruneMonitor keeps; also here, so a flood of tries can't grow the table until then

export function recordLogin(result: LoginResult, ip: string, agent: string, at = Date.now()): void {
  const row = db.prepare("INSERT INTO admin_logins (at, ip, agent, result) VALUES (?, ?, ?, ?)").run(at, ip, agent.slice(0, 200), result);
  db.prepare("DELETE FROM admin_logins WHERE id <= ?").run(Number(row.lastInsertRowid) - LOGINS_KEPT);
}

const TRUSTED_FOR_MS = 30 * DAY;

/** Whether this address has signed in successfully in the last 30 days, or still has a session. */
function signedInBefore(ip: string, now: number): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM admin_sessions WHERE ip = ? AND expires_at > ?
       UNION ALL SELECT 1 FROM admin_logins WHERE ip = ? AND result = 'ok' AND at > ? LIMIT 1`,
    )
    .get(ip, now, ip, now - TRUSTED_FOR_MS);
}

// A blocked address is logged once a minute at most: a flood of refused tries would otherwise push the real sign-ins
// out of the 500 rows kept.
const blockedLogged = new Map<string, number>();
function noteBlocked(ip: string, agent: string, now: number): void {
  const key = limitKey(ip);
  if (now - (blockedLogged.get(key) ?? 0) < MINUTE) return;
  for (const [other, at] of blockedLogged) if (now - at >= MINUTE) blockedLogged.delete(other);
  blockedLogged.set(key, now);
  recordLogin("blocked", ip, agent, now);
}

export type SignIn = { username: string; password: string; ip: string; agent: string };
export type SignInResult = { result: "ok"; session: NewSession } | { result: "wrong"; block?: Block } | { result: "blocked"; retryAfterMs: number };

let queue: Promise<unknown> = Promise.resolve();

/**
 * One sign-in try: refused while blocked (before the password is checked), counted when wrong, a new session when
 * right, and logged either way. Tries run one at a time, so a burst sent in parallel can't get past the limits while
 * passwords are being checked.
 */
export function signIn({ username, password, ip, agent }: SignIn): Promise<SignInResult> {
  const run = queue.then(async (): Promise<SignInResult> => {
    const now = Date.now();
    const allowed = loginAllowed(ip, now, signedInBefore(ip, now));
    if (!allowed.ok) {
      noteBlocked(ip, agent, now);
      return { result: "blocked", retryAfterMs: allowed.retryAfterMs };
    }
    if (!(await checkCredentials(username, password))) {
      const block = noteFailure(ip);
      recordLogin("wrong", ip, agent);
      return block ? { result: "wrong", block } : { result: "wrong" };
    }
    noteSuccess(ip);
    recordLogin("ok", ip, agent);
    return { result: "ok", session: startSession(ip, agent) };
  });
  queue = run.catch(() => {});
  return run;
}

// A session lasts 7 days after it was last used, and never more than 30 days after signing in.
const IDLE_MS = 7 * DAY;
export const SESSION_MAX_MS = 30 * DAY;
const REFRESH_MS = 5 * MINUTE;
const MAX_SESSIONS = 20;

/** token goes only in the cookie; id is its SHA-256 (admin_sessions.id). */
export type NewSession = { token: string; id: string; csrf: string };
export type Session = { id: string; csrf: string };

const tokenId = (token: string) => sha256(token).toString("hex");
const randomToken = () => randomBytes(32).toString("base64url");

/** Changes with the username or the password hash, so setting a new password signs every browser out. */
function credential(): string {
  return sha256(JSON.stringify(["friday-admin", config.ADMIN_USER, config.ADMIN_PASSWORD_HASH])).toString("hex");
}

// Sessions made with an older username or password can never be used again.
db.prepare("DELETE FROM admin_sessions WHERE credential != ?").run(credential());

export function startSession(ip: string, agent: string, now = Date.now()): NewSession {
  const token = randomToken();
  const session = { token, id: tokenId(token), csrf: randomToken() };
  db.prepare(
    "INSERT INTO admin_sessions (id, csrf, credential, created_at, seen_at, expires_at, ip, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(session.id, session.csrf, credential(), now, now, now + IDLE_MS, ip, agent.slice(0, 200));
  db.prepare("DELETE FROM admin_sessions WHERE id NOT IN (SELECT id FROM admin_sessions ORDER BY created_at DESC, rowid DESC LIMIT ?)").run(
    MAX_SESSIONS,
  );
  return session;
}

type SessionRow = { csrf: string; credential: string; created_at: number; seen_at: number; expires_at: number };

/** The session a cookie's token belongs to, while it's valid. Moves its expiry along at most every 5 minutes. */
export function sessionFor(token: string | undefined, now = Date.now()): Session | undefined {
  if (!token || !dashboardConfigured()) return undefined;
  const id = tokenId(token);
  const row = db.prepare("SELECT csrf, credential, created_at, seen_at, expires_at FROM admin_sessions WHERE id = ?").get(id) as SessionRow | undefined;
  if (!row || row.expires_at <= now || row.credential !== credential()) return undefined;
  if (now - row.seen_at >= REFRESH_MS) {
    const expiresAt = Math.min(now + IDLE_MS, row.created_at + SESSION_MAX_MS);
    db.prepare("UPDATE admin_sessions SET seen_at = ?, expires_at = ? WHERE id = ?").run(now, expiresAt, id);
  }
  return { id, csrf: row.csrf };
}

export function endSession(id: string): void {
  db.prepare("DELETE FROM admin_sessions WHERE id = ?").run(id);
}

/** Signs every other browser out; returns how many there were. */
export function endOtherSessions(id: string): number {
  return db.prepare("DELETE FROM admin_sessions WHERE id != ?").run(id).changes;
}
