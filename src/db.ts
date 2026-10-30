import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    chat_id     TEXT PRIMARY KEY,
    system      TEXT NOT NULL,
    messages    TEXT NOT NULL,
    tokens      INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    text        TEXT NOT NULL,
    due_at      INTEGER NOT NULL,
    cron        TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reminders_due ON reminders (active, due_at);
  CREATE TABLE IF NOT EXISTS contacts (
    number      TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    added_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage (
    number      TEXT NOT NULL,
    day         TEXT NOT NULL,
    count       INTEGER NOT NULL,
    PRIMARY KEY (number, day)
  );
  CREATE TABLE IF NOT EXISTS images (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT NOT NULL,
    mimetype    TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner       TEXT NOT NULL,
    fact        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT NOT NULL,
    number      TEXT NOT NULL,
    code        TEXT NOT NULL,
    action      TEXT NOT NULL,
    params      TEXT NOT NULL,
    token       TEXT,
    summary     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    result      TEXT,
    noted       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS errands (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_number  TEXT NOT NULL,
    requester_chat    TEXT NOT NULL,
    requester_name    TEXT NOT NULL,
    target_number     TEXT NOT NULL,
    target_chat       TEXT NOT NULL,
    target_name       TEXT NOT NULL,
    goal              TEXT NOT NULL,
    first_message     TEXT NOT NULL,
    code              TEXT NOT NULL,
    status            TEXT NOT NULL,
    turns             INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS errands_target ON errands (target_number, status);
  CREATE TABLE IF NOT EXISTS token_usage (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    day          TEXT NOT NULL,
    number       TEXT NOT NULL,
    name         TEXT NOT NULL,
    model        TEXT NOT NULL,
    input        INTEGER NOT NULL,
    cache_read   INTEGER NOT NULL,
    cache_write  INTEGER NOT NULL,
    output       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS token_usage_day ON token_usage (day, number);
  -- cache_write = 5-minute cache writes; cache_write_1h and web_searches were added later (see below).
  CREATE TABLE IF NOT EXISTS usage_alerts (
    day  TEXT NOT NULL,
    key  TEXT NOT NULL,
    PRIMARY KEY (day, key)
  );
  CREATE TABLE IF NOT EXISTS polls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id      TEXT NOT NULL UNIQUE,
    chat_id     TEXT NOT NULL,
    question    TEXT NOT NULL,
    options     TEXT NOT NULL,
    secret      TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id     INTEGER NOT NULL,
    voter       TEXT NOT NULL,
    name        TEXT,
    choices     TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (poll_id, voter)
  );
  CREATE TABLE IF NOT EXISTS errand_notes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_chat  TEXT NOT NULL,
    text            TEXT NOT NULL,
    noted           INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pauses (
    chat_id     TEXT PRIMARY KEY,
    chat_name   TEXT NOT NULL,
    until       INTEGER
  );
  -- until = NULL: paused until the admin resumes it.
`);

// Columns added after a table first shipped: SQLite's CREATE TABLE IF NOT EXISTS won't add them to an existing one.
for (const [table, column, type] of [
  ["token_usage", "cache_write_1h", "INTEGER NOT NULL DEFAULT 0"],
  ["token_usage", "web_searches", "INTEGER NOT NULL DEFAULT 0"],
] as const) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
