import { config } from "./config.js";
import { allContacts } from "./contacts.js";
import { db } from "./db.js";
import { localDay } from "./time.js";
import type { ChatContext, Outbox } from "./types.js";

// The website's button opens WhatsApp with this sentence already typed. Friday answers it once per number with a fixed
// text, so it costs nothing, and tells the admin, who decides with /add. Anything else from a stranger stays ignored.

const REQUEST = "halo friday, aku mau coba";
const REPLY = "Halo! 👋 Friday saat ini hanya bisa dipakai lewat undangan. Permintaanmu sudah saya teruskan ke pengelola. Kalau disetujui, nanti saya sapa kamu di sini ya.";

/** The name comes from the sender's WhatsApp profile, so it can't be trusted to look like a name. */
const cleanName = (name: string) => name.replace(/[^\p{L}\p{N} .'-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 30) || "Tanpa Nama";

/** Returns true when the message was an access request, answered or not. */
export async function handleAccessRequest(chat: ChatContext, text: string, outbox: Outbox): Promise<boolean> {
  if (!text.trim().toLowerCase().startsWith(REQUEST)) return false;
  const { number } = chat.sender;
  if (db.prepare("SELECT 1 FROM access_requests WHERE number = ?").get(number)) return true;

  const today = localDay();
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM access_requests WHERE day = ?").get(today) as { count: number };
  if (count >= config.ACCESS_REQUEST_DAILY_LIMIT) {
    console.log(`Access request from +${number} not answered: today's limit is reached.`);
    return true;
  }

  const name = cleanName(chat.sender.name);
  db.prepare("INSERT INTO access_requests (number, name, day) VALUES (?, ?, ?)").run(number, name, today);
  await outbox.sendText(chat.chatId, REPLY);
  const admin = allContacts()[0];
  if (admin) await outbox.sendText(outbox.chatIdFor(admin.number), `📥 ${name} (+${number}) minta akses lewat website.\nIzinkan dengan: /add ${name} ${number}`);
  return true;
}
