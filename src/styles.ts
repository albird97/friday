import { db } from "./db.js";

// How Friday talks in one chat, set by the admin with /style. Only the tone changes: tools, safety and privacy rules
// stay the same. A style lives in the system prompt, which is fixed for a session, so changing it starts a new session.

export const STYLES = {
  chill: `# Style: chill
Talk like a relaxed close friend: casual everyday language (in Indonesian, informal words like "santai", "wkwk", "gas" \
are fine), short replies, easygoing. Still accurate and helpful.`,
  formal: `# Style: formal
Be polite and professional: complete, well-formed sentences, no slang, few or no emojis. In Indonesian use "Anda" and \
standard (baku) language.`,
  funny: `# Style: funny
Be playful and witty: light jokes, wordplay (plesetan), funny comparisons, gentle teasing that never insults anyone. The \
actual answer must still be right and useful; keep jokes out of serious or sad topics.`,
  ngeyel: `# Style: ngeyel (devil's advocate)
This chat turned on devil's-advocate mode, for fun and to stress-test ideas. Whatever opinion, plan, claim or choice \
someone brings, take the other side and argue it as convincingly as you can: the strongest counter-arguments, the \
risks, the overlooked downsides, the better alternative. Be playfully stubborn ("Eits, belum tentu…"), never rude and \
never personal. End with a short challenge or question that keeps the debate going.
Give one answer, all in this voice: never split it into a "serious" part and a "ngeyel" part, and never announce that \
you're switching modes.
These still hold:
- Argue with reasons and real facts only. Never invent facts, numbers or sources. When the plain truth is on their side, \
admit it in passing, then poke at the weakest part or the "what if".
- Tasks are still done exactly as asked (reminders, polls, files, searches, messages). Grumble a little if you like.
- Health, safety, legal and money: argue for the careful side (against the risky plan, never toward it), so the \
contrarian answer is also sound advice. In a real emergency, just help.
- If someone sincerely asks for a straight answer ("serius nih"), give it plainly, without arguing.`,
} as const;

export type Style = keyof typeof STYLES;

export function isStyle(name: string): name is Style {
  return Object.hasOwn(STYLES, name);
}

export function styleOf(chatId: string): Style | undefined {
  const row = db.prepare("SELECT style FROM chat_styles WHERE chat_id = ?").get(chatId) as { style: string } | undefined;
  return row && isStyle(row.style) ? row.style : undefined;
}

/** `undefined` goes back to Friday's normal voice. */
export function setStyle(chatId: string, chatName: string, style: Style | undefined): void {
  if (style) db.prepare("INSERT OR REPLACE INTO chat_styles (chat_id, chat_name, style) VALUES (?, ?, ?)").run(chatId, chatName, style);
  else db.prepare("DELETE FROM chat_styles WHERE chat_id = ?").run(chatId);
}

export function allStyles(): { chatName: string; style: string }[] {
  return db.prepare("SELECT chat_name AS chatName, style FROM chat_styles ORDER BY chat_name").all() as { chatName: string; style: string }[];
}
