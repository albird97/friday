import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// .env wins over variables already in the shell, so the bot always runs with the settings in its own file.
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? ".env", override: true, quiet: true });

const Env = z.object({
  // Image creation/editing. "cloudflare" is free (Workers AI free plan); "gemini" is paid per image.
  IMAGE_PROVIDER: z.enum(["cloudflare", "gemini"]).default("cloudflare"),
  CLOUDFLARE_ACCOUNT_ID: z.string().default(""),
  CLOUDFLARE_API_TOKEN: z.string().default(""),
  CLOUDFLARE_IMAGE_MODEL: z.string().default("@cf/black-forest-labs/flux-2-klein-4b"),
  // Voice notes are transcribed with this Workers AI model (same Cloudflare account and free allowance).
  CLOUDFLARE_STT_MODEL: z.string().default("@cf/openai/whisper-large-v3-turbo"),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_IMAGE_MODEL: z.string().default("gemini-nano-banana-2.1"),
  FRIDAY_MODEL: z.string().default("claude-opus-5-5"),
  FRIDAY_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  BOT_NAME: z.string().default("Friday"),
  TIMEZONE: z.string().default("Asia/Jakarta"),
  // "Albert=6281234567890, Sarah=6289876543210" — who may talk to the bot in private chats.
  // The first entry is the admin, who can add/remove people from WhatsApp with /add and /remove.
  ALLOWED_CONTACTS: z.string().default(""),
  // In groups: "everyone" lets any member talk to the bot (by mention/reply), "contacts" only known contacts.
  GROUP_ACCESS: z.enum(["everyone", "contacts"]).default("everyone"),
  // Messages per person per day (the admin is exempt). 0 = unlimited.
  DAILY_MESSAGE_LIMIT: z.coerce.number().int().min(0).default(50),
  // Optional: link with an 8-character pairing code instead of a QR code (bot's own number, digits only).
  PAIRING_NUMBER: z.string().default(""),
  DATA_DIR: z.string().default("./data"),
  // A chat's conversation starts fresh after this much silence, or once it grows past this many tokens.
  SESSION_IDLE_HOURS: z.coerce.number().positive().default(6),
  SESSION_MAX_TOKENS: z.coerce.number().positive().default(80_000),
  LOG_LEVEL: z.string().default("info"),
  // onehub (the business back office). Numbers that may use it, in private chats only: "6281234567890,6289876543210".
  ONEHUB_USERS: z.string().default(""),
  // Read access: a PostgreSQL URL for a role that can only SELECT, e.g. postgres://friday_ro:…@127.0.0.1:5432/onehub
  ONEHUB_DATABASE_URL: z.string().default(""),
  // Actions: onehub's internal Friday API (…/internal/friday) and its token.
  ONEHUB_API_URL: z.string().default(""),
  ONEHUB_API_TOKEN: z.string().default(""),
  // Errands: numbers that may have Friday message people outside the contacts (restaurants, shops…), private chats only.
  ERRAND_USERS: z.string().default(""),
  // New errands per day across everyone — messaging strangers a lot gets a number flagged as spam.
  ERRAND_DAILY_LIMIT: z.coerce.number().int().min(0).default(10),
});

const env = Env.parse(process.env);

export type Contact = { name: string; number: string };

export function parseContacts(raw: string): Contact[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, number] = entry.includes("=") ? entry.split("=", 2) : ["", entry];
      const digits = number.replace(/\D/g, "");
      if (digits.length < 8) throw new Error(`ALLOWED_CONTACTS: "${entry}" is not a valid phone number`);
      return { name: name.trim() || digits, number: digits };
    });
}

export const config = {
  ...env,
  contacts: parseContacts(env.ALLOWED_CONTACTS),
  pairingNumber: env.PAIRING_NUMBER.replace(/\D/g, ""),
  onehubUsers: env.ONEHUB_USERS.split(",").map((n) => n.replace(/\D/g, "")).filter(Boolean),
  errandUsers: env.ERRAND_USERS.split(",").map((n) => n.replace(/\D/g, "")).filter(Boolean),
  authDir: path.join(env.DATA_DIR, "whatsapp-auth"),
  dbPath: path.join(env.DATA_DIR, "friday.db"),
  outboxDir: path.join(env.DATA_DIR, "outbox"),
};
