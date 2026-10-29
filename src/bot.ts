import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { respond } from "./agent.js";
import { config } from "./config.js";
import sharp from "sharp";
import { addContact, allContacts, isAdmin, removeContact, takeDailyQuota } from "./contacts.js";
import { imagesEnabled, saveImage } from "./images.js";
import { confirmErrand, errandFor, errandIncoming, errandNotes } from "./errands.js";
import { actionNotes, confirmAction } from "./onehub.js";
import { deleteSession } from "./session.js";
import { usageReport } from "./usage.js";
import { nowStamp } from "./time.js";
import type { ChatContext, Outbox } from "./types.js";

export type Media = {
  kind: "image" | "document" | "audio" | "video" | "sticker";
  mimetype: string;
  fileName?: string;
  size?: number;
  download: () => Promise<Buffer>;
};

/** A message from any channel (WhatsApp or the terminal), already identified and normalised. */
export type Incoming = {
  chat: ChatContext;
  text: string;
  /** Text of the message being replied to, if any. */
  quoted?: string;
  media?: Media;
  /** Private chats: always. Groups: the bot was mentioned, replied to, or called by name. */
  addressed: boolean;
};

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TEXT_FILE = /\.(txt|md|csv|tsv|json|xml|html?|log|ya?ml|ics|vcf)$/i;

const queues = new Map<string, Promise<void>>();

/** Handles messages one at a time per chat, so a conversation never runs two turns at once. */
export function handleIncoming(msg: Incoming, outbox: Outbox): Promise<void> {
  const chatId = msg.chat.chatId;
  const next = (queues.get(chatId) ?? Promise.resolve())
    .then(() => processMessage(msg, outbox))
    .catch((err) => console.error(`[${msg.chat.chatName}] failed to handle message`, err));
  queues.set(chatId, next);
  void next.finally(() => queues.get(chatId) === next && queues.delete(chatId));
  return next;
}

async function processMessage(msg: Incoming, outbox: Outbox): Promise<void> {
  const { chat } = msg;
  if (!msg.addressed) return;

  if (!chat.isGroup && !chat.sender.isContact) {
    // Strangers are ignored — unless Friday wrote to them first on someone's behalf (an errand).
    const errand = errandFor(chat.sender.number);
    const content = errand && (await toContent(msg));
    if (errand && content) {
      await errandIncoming(errand, chat, msg.text || `[${msg.media?.kind ?? "message"}]`, content, outbox);
      return;
    }
    console.log(`Ignored a private message from ${chat.sender.name} (+${chat.sender.number}), who isn't a contact. To allow them, send Friday: /add <name> ${chat.sender.number}`);
    return;
  }
  if (chat.isGroup && config.GROUP_ACCESS === "contacts" && !chat.sender.isContact) return;

  if (msg.text.startsWith("/") && (await runCommand(msg, outbox))) return;
  if (await confirmErrand(chat, msg.text, outbox)) return;
  if (await confirmAction(chat, msg.text, outbox)) return;

  if (!takeDailyQuota(chat.sender.number)) {
    await outbox.sendText(chat.chatId, `You've reached today's limit of ${config.DAILY_MESSAGE_LIMIT} messages. Talk tomorrow! 👋`, chat.replyTo);
    return;
  }

  const content = await toContent(msg);
  if (!content) return;
  for (const notes of [errandNotes(chat), actionNotes(chat)]) if (notes) content.unshift({ type: "text", text: notes });
  await respond(chat, content, outbox);
}

/** Slash commands handled without Claude. Returns false for unknown commands, which go to Claude as text. */
async function runCommand(msg: Incoming, outbox: Outbox): Promise<boolean> {
  const { chat } = msg;
  const [command, ...args] = msg.text.trim().split(/\s+/);
  const reply = (text: string) => outbox.sendText(chat.chatId, text, chat.replyTo);
  const admin = isAdmin(chat.sender.number);
  // Who uses Friday (and how much) is for the admin's eyes only: admin answers always go to their private chat.
  const toAdmin = (text: string) => outbox.sendText(outbox.chatIdFor(chat.sender.number), text);

  switch (command.toLowerCase()) {
    case "/help":
      await reply(
        [
          `*${config.BOT_NAME}* — just talk to me normally${chat.isGroup ? ` (mention me, reply to me, or start with "${config.BOT_NAME},")` : ""}.`,
          `I can answer questions, search the web, set reminders, read photos and PDFs, make PDF / Word / Excel / PowerPoint files${imagesEnabled ? ", and create or edit pictures" : ""}.`,
          "",
          "/reset — start a fresh conversation (keeps memories and reminders)",
          "/id — show this chat's id and your number",
          ...(admin && !chat.isGroup
            ? ["", "_Admin:_", "/usage — Claude tokens per person", "/contacts — who can use me", "/add <name> <number> — allow someone", "/remove <name> — remove someone"]
            : []),
        ].join("\n"),
      );
      return true;
    case "/reset":
    case "/new":
      deleteSession(chat.chatId);
      await reply("Fresh start! 🧹 I've cleared this conversation. Memories and reminders are kept.");
      return true;
    case "/id":
      await reply(`Chat id: ${chat.chatId}\nYour number: +${chat.sender.number}`);
      return true;
    case "/usage":
    case "/contacts": {
      if (!admin) return false;
      const answer =
        command.toLowerCase() === "/usage"
          ? usageReport()
          : allContacts().map((c, i) => `${i === 0 ? "👑" : "-"} ${c.name} (+${c.number})`).join("\n") || "No contacts yet.";
      await toAdmin(answer);
      return true;
    }
    case "/add": {
      if (!admin) return false;
      const number = args.at(-1) ?? "";
      const name = args.slice(0, -1).join(" ");
      if (!name || !/\d{8,}/.test(number.replace(/\D/g, ""))) {
        await toAdmin("Usage: /add <name> <number with country code>\nExample: /add Mom 6281234567890");
        return true;
      }
      try {
        const contact = addContact(name, number);
        await toAdmin(`✅ ${contact.name} (+${contact.number}) can now chat with me.`);
      } catch (err) {
        await toAdmin(err instanceof Error ? err.message : String(err));
      }
      return true;
    }
    case "/remove": {
      if (!admin) return false;
      const result = removeContact(args.join(" "));
      await toAdmin(result.removed ? `Removed ${result.removed.name}.` : (result.error ?? "Couldn't remove that contact."));
      return true;
    }
    default:
      return false;
  }
}

type ImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Passes JPEG/PNG/GIF/WebP under 5 MB through; converts anything else (or bigger) to a JPEG Claude can read. */
async function readableImage(mimetype: string, data: Buffer): Promise<{ mimetype: ImageType; data: Buffer } | undefined> {
  if (IMAGE_TYPES.has(mimetype) && data.length <= MAX_IMAGE_BYTES) return { mimetype: mimetype as ImageType, data };
  try {
    const jpeg = await sharp(data).rotate().resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return { mimetype: "image/jpeg", data: jpeg };
  } catch {
    return undefined;
  }
}

/** Builds Claude's user turn: attachments first, then the stamped text. */
async function toContent(msg: Incoming): Promise<BetaContentBlockParam[] | undefined> {
  const blocks: BetaContentBlockParam[] = [];
  const notes: string[] = [];
  const media = msg.media;

  if (media) {
    const name = media.fileName ? ` "${media.fileName}"` : "";
    if (media.kind === "audio") notes.push("[They sent a voice note/audio, which you can't listen to.]");
    else if (media.kind === "video") notes.push("[They sent a video, which you can't watch.]");
    else if ((media.size ?? 0) > MAX_FILE_BYTES) notes.push(`[They sent a file${name} that's too large for you to open (over 20 MB).]`);
    else if (media.kind === "image" || media.kind === "sticker") {
      const image = await readableImage(media.mimetype.split(";")[0], await media.download());
      if (image) {
        blocks.push({ type: "image", source: { type: "base64", media_type: image.mimetype, data: image.data.toString("base64") } });
        if (imagesEnabled) notes.push(`[The photo above is image #${saveImage(msg.chat.chatId, image.mimetype, image.data)}.]`);
      } else notes.push("[They sent an image you can't open (unsupported format).]");
    } else if (media.mimetype === "application/pdf") {
      const data = await media.download();
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") }, title: media.fileName });
    } else if (media.mimetype.startsWith("text/") || TEXT_FILE.test(media.fileName ?? "")) {
      const data = await media.download();
      blocks.push({ type: "document", source: { type: "text", media_type: "text/plain", data: data.toString("utf8") }, title: media.fileName });
    } else {
      notes.push(`[They sent a file${name} (${media.mimetype}) that you can't open. You can read PDFs, images and text files; suggest sending a PDF.]`);
    }
  }

  if (!msg.text && blocks.length === 0 && notes.length === 0) return undefined;

  let text = `[${nowStamp()}] ${msg.chat.sender.name}: ${msg.text}`.trimEnd();
  if (msg.quoted) text += `\n(Replying to: "${msg.quoted.length > 1500 ? `${msg.quoted.slice(0, 1500)}…` : msg.quoted}")`;
  if (notes.length) text += `\n${notes.join("\n")}`;
  blocks.push({ type: "text", text });
  return blocks;
}
