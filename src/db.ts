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
`);
