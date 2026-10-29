import { db } from "./db.js";

/** Facts Friday keeps between conversations. `owner` is a phone number, or "shared" for the household. */
export type Memory = { id: number; owner: string; fact: string };

export const SHARED = "shared";

export function addMemory(owner: string, fact: string): number {
  const result = db
    .prepare("INSERT INTO memories (owner, fact, created_at) VALUES (?, ?, ?)")
    .run(owner, fact.trim(), Date.now());
  return Number(result.lastInsertRowid);
}

export function memoriesFor(owners: string[]): Memory[] {
  if (owners.length === 0) return [];
  const placeholders = owners.map(() => "?").join(",");
  return db
    .prepare(`SELECT id, owner, fact FROM memories WHERE owner IN (${placeholders}) ORDER BY id`)
    .all(...owners) as Memory[];
}

/** Deletes a memory only if it belongs to one of `owners`. */
export function forgetMemory(id: number, owners: string[]): boolean {
  const placeholders = owners.map(() => "?").join(",");
  const result = db
    .prepare(`DELETE FROM memories WHERE id = ? AND owner IN (${placeholders})`)
    .run(id, ...owners);
  return result.changes > 0;
}
