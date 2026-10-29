import { contactByNumber } from "./contacts.js";
import { db } from "./db.js";
import { formatDateTime } from "./time.js";

// Polls Friday sends in a chat (who's coming to a get-together, which date…). People vote with a tap; WhatsApp delivers
// each vote encrypted, the WhatsApp layer decrypts it and calls recordVote. Reading the results never costs Claude credit.

export type Poll = {
  id: number;
  msg_id: string;
  chat_id: string;
  question: string;
  options: string[];
  secret: Buffer;
  created_at: number;
};

type PollRow = Omit<Poll, "options" | "secret"> & { options: string; secret: string };

const fromRow = (r: PollRow | undefined): Poll | undefined =>
  r && { ...r, options: JSON.parse(r.options) as string[], secret: Buffer.from(r.secret, "base64") };

export function savePoll(p: { msgId: string; chatId: string; question: string; options: string[]; secret: Buffer; createdBy: string }): number {
  const result = db
    .prepare("INSERT INTO polls (msg_id, chat_id, question, options, secret, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(p.msgId, p.chatId, p.question, JSON.stringify(p.options), p.secret.toString("base64"), p.createdBy, Date.now());
  return Number(result.lastInsertRowid);
}

export function pollByMessage(msgId: string): Poll | undefined {
  return fromRow(db.prepare("SELECT * FROM polls WHERE msg_id = ?").get(msgId) as PollRow | undefined);
}

/** A poll sent in this chat: by number, or the latest one. */
export function pollInChat(chatId: string, id?: number): Poll | undefined {
  const row =
    id === undefined
      ? db.prepare("SELECT * FROM polls WHERE chat_id = ? ORDER BY id DESC LIMIT 1").get(chatId)
      : db.prepare("SELECT * FROM polls WHERE chat_id = ? AND id = ?").get(chatId, id);
  return fromRow(row as PollRow | undefined);
}

/** Stores someone's current choice; an empty choice means they took their vote back. */
export function recordVote(pollId: number, voter: string, name: string | undefined, choices: string[]): void {
  if (choices.length === 0) {
    db.prepare("DELETE FROM poll_votes WHERE poll_id = ? AND voter = ?").run(pollId, voter);
    return;
  }
  db.prepare(
    `INSERT INTO poll_votes (poll_id, voter, name, choices, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (poll_id, voter) DO UPDATE SET name = COALESCE(excluded.name, poll_votes.name), choices = excluded.choices,
       updated_at = excluded.updated_at`,
  ).run(pollId, voter, name ?? null, JSON.stringify(choices), Date.now());
}

/**
 * Who chose what, for Claude to answer "who's coming?". Voters are named as in the poll itself (contact name or their
 * WhatsApp name); people who haven't voted are only counted, so the results never reveal which members are contacts.
 */
export function pollResults(poll: Poll, members?: number): string {
  const votes = db.prepare("SELECT voter, name, choices FROM poll_votes WHERE poll_id = ? ORDER BY updated_at").all(poll.id) as {
    voter: string;
    name: string | null;
    choices: string;
  }[];
  const nameOf = (v: (typeof votes)[number]) => contactByNumber(v.voter)?.name ?? v.name ?? "(no name)";
  const lines = poll.options.map((option) => {
    const who = votes.filter((v) => (JSON.parse(v.choices) as string[]).includes(option)).map(nameOf);
    return `- ${option} (${who.length})${who.length ? `: ${who.join(", ")}` : ""}`;
  });
  const waiting = members === undefined ? "" : `\nNot voted yet: ${Math.max(members - votes.length, 0)} of ${members} members.`;
  return `Poll #${poll.id} "${poll.question}" (sent ${formatDateTime(new Date(poll.created_at))}), ${votes.length} voted:\n${lines.join("\n")}${waiting}`;
}
