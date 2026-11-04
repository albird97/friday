import { allContacts, isAdmin } from "./contacts.js";
import { db } from "./db.js";
import type { ChatContext, Outbox } from "./types.js";

// /umumkan: the admin's words go to every contact's private chat, exactly as written and with no sender label. Friday
// is a linked device rather than the official API, so it sends one at a time to avoid looking like spam.

const GAP_MS = 3000;

/** Sends to everyone but the admin and says how that went, for the admin. One failure never stops the rest. */
export async function announce(text: string, outbox: Outbox, gapMs = GAP_MS): Promise<string> {
  const contacts = allContacts().filter((c) => !isAdmin(c.number));
  if (contacts.length === 0) return "Belum ada kontak lain untuk dikirimi pengumuman.";
  const failed: string[] = [];
  for (const [i, contact] of contacts.entries()) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
    const chatId = outbox.chatIdFor(contact.number);
    try {
      if ((await outbox.isOnWhatsApp?.(contact.number)) === false) throw new Error("tidak terdaftar di WhatsApp");
      await outbox.sendText(chatId, text);
      db.prepare("INSERT INTO announcement_notes (chat_id, text, created_at) VALUES (?, ?, ?)").run(chatId, text, Date.now());
    } catch (err) {
      failed.push(`- ${contact.name} (+${contact.number}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const report = `📣 Pengumuman terkirim ke *${contacts.length - failed.length}* dari ${contacts.length} kontak.`;
  return failed.length ? `${report}\n\n⚠️ Gagal:\n${failed.join("\n")}` : report;
}

/** Announcements this chat hasn't talked about yet, so Friday knows what someone is replying to. Each is given once. */
export function announcementNotes(chat: ChatContext): string | undefined {
  const rows = db.prepare("DELETE FROM announcement_notes WHERE chat_id = ? RETURNING text").all(chat.chatId) as { text: string }[];
  if (rows.length === 0) return undefined;
  return `[System note — announcements already sent to this person, don't repeat them:\n${rows.map((r) => `- ${r.text}`).join("\n")}]`;
}
