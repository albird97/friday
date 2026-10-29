/**
 * Chat with Friday in the terminal — same brain, tools and database as WhatsApp, no phone needed.
 *   npm run chat
 * Attach a file with:  /attach path/to/file.pdf  what does this say?
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { handleIncoming, type Media } from "./bot.js";
import { config } from "./config.js";
import { isTerminalChat, startReminderLoop } from "./reminders.js";
import type { Outbox } from "./types.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is missing. Copy .env.example to .env and paste your Claude API key into it.");
  process.exit(1);
}

const me = config.contacts[0] ?? { name: "You", number: "10000000000" };
const label = (chatId: string) => (chatId === "cli" ? "" : ` → ${chatId}`);

const outbox: Outbox = {
  async sendText(chatId, text) {
    console.log(`\n\x1b[36m${config.BOT_NAME}${label(chatId)}:\x1b[0m ${text}\n`);
  },
  async sendFile(chatId, file) {
    fs.mkdirSync(config.outboxDir, { recursive: true });
    const target = path.join(config.outboxDir, file.fileName);
    fs.writeFileSync(target, file.data);
    console.log(`\n\x1b[36m📎 ${file.fileName}${label(chatId)}\x1b[0m saved to ${target}${file.caption ? `\n   ${file.caption}` : ""}\n`);
  },
  async sendImage(chatId, image) {
    await outbox.sendFile(chatId, { ...image, fileName: `image-${Date.now()}.${image.mimetype.split("/")[1] ?? "png"}` });
  },
  async typing() {},
  chatIdFor: (number) => `cli:${number}`,
};

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

startReminderLoop(outbox, isTerminalChat);
console.log(`Chatting with ${config.BOT_NAME} as ${me.name}. Ctrl+C to quit. /help for commands, /attach <file> [message] to send a file.\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("close", () => process.exit(0));
for (;;) {
  let text = (await rl.question("\x1b[33myou:\x1b[0m ")).trim();
  if (!text) continue;

  let media: Media | undefined;
  const attach = text.match(/^\/attach\s+(\S+)\s*(.*)$/);
  if (attach) {
    const file = path.resolve(attach[1]);
    if (!fs.existsSync(file)) {
      console.log(`No such file: ${file}`);
      continue;
    }
    const mimetype = MIME[path.extname(file).toLowerCase()] ?? "text/plain";
    media = {
      kind: mimetype.startsWith("image/") ? "image" : "document",
      mimetype,
      fileName: path.basename(file),
      size: fs.statSync(file).size,
      download: async () => fs.readFileSync(file),
    };
    text = attach[2];
  }

  await handleIncoming(
    {
      chat: { chatId: "cli", isGroup: false, chatName: "terminal", sender: { ...me, isContact: true } },
      text,
      media,
      addressed: true,
    },
    outbox,
  );
}
