import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";

// The dashboard's password is kept only as a scrypt hash: "scrypt:N:r:p:<salt>:<hash>", salt and hash in base64url.
// Node built-ins only, so `scripts/linux-service.sh admin` can hash a password without Friday's settings or database:
//   printf '%s' "$PASSWORD" | node --import tsx src/admin/password.ts

type Cost = { N: number; r: number; p: number };

const COST: Cost = { N: 16384, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 32;
export const MIN_PASSWORD_LENGTH = 10;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function derive(password: string, salt: Buffer, { N, r, p }: Cost): Promise<Buffer> {
  // scrypt needs about 128·N·r bytes, which already passes Node's default cap at N = 2^15. NFC: the same password typed
  // on a phone and on a laptop gives the same bytes.
  const options = { N, r, p, maxmem: 256 * N * r };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFC"), salt, KEY_BYTES, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// Hashes are only read back within these bounds: enough work to be worth hashing, and never so much that one sign-in
// could take the server's memory (the service is capped at 400 MB) or its CPU.
const saneCost = ({ N, r, p }: Cost) => N >= 2 ** 14 && N <= 2 ** 16 && (N & (N - 1)) === 0 && r >= 1 && r <= 8 && p >= 1 && p <= 4;

function parse(stored: string): (Cost & { salt: Buffer; key: Buffer }) | undefined {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
  const [N, r, p] = parts.slice(1, 4).map((part) => (/^\d{1,6}$/.test(part) ? Number(part) : NaN));
  const [salt, key] = parts.slice(4).map((part) => (BASE64URL.test(part) ? Buffer.from(part, "base64url") : Buffer.alloc(0)));
  if (!saneCost({ N, r, p }) || salt.length < SALT_BYTES || salt.length > 64 || key.length !== KEY_BYTES) return undefined;
  return { N, r, p, salt, key };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64url"), key.toString("base64url")].join(":");
}

/** Constant-time. Never throws: a malformed stored value matches nothing. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  try {
    return timingSafeEqual(await derive(password, parsed.salt, parsed), parsed.key);
  } catch {
    return false;
  }
}

export function isPasswordHash(stored: string): boolean {
  return parse(stored) !== undefined;
}

async function main(): Promise<void> {
  // Typed at a terminal, the password would show on screen.
  if (process.stdin.isTTY) {
    console.error(`Pipe the password in: printf '%s' "$PASSWORD" | node --import tsx src/admin/password.ts`);
    process.exitCode = 1;
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    console.error(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exitCode = 1;
    return;
  }
  console.log(await hashPassword(password));
}

function runDirectly(): boolean {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

if (runDirectly()) await main();
