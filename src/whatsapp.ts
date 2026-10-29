import fs from "node:fs";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageContent,
  type WASocket,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import type { Incoming, Media } from "./bot.js";
import { config } from "./config.js";
import { contactByNumber } from "./contacts.js";
import type { Outbox } from "./types.js";

const logger = pino({ level: "warn" });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAME_TRIGGER = new RegExp(
  `^\\s*(?:(?:hey|hi|hai|halo|hello|ok|oke)\\s+${escape(config.BOT_NAME)}\\b|${escape(config.BOT_NAME)}\\s*[,:!?])`,
  "i",
);

function textOf(content: WAMessageContent | undefined): string {
  return (
    content?.conversation ??
    content?.extendedTextMessage?.text ??
    content?.imageMessage?.caption ??
    content?.videoMessage?.caption ??
    content?.documentMessage?.caption ??
    ""
  );
}

/** Connects to WhatsApp as a linked device and feeds incoming messages to `onMessage`. */
export async function startWhatsApp(onMessage: (msg: Incoming, outbox: Outbox) => void): Promise<Outbox> {
  let sock: WASocket;
  const groupNames = new Map<string, string>();

  const outbox: Outbox = {
    async sendText(chatId, text, quote) {
      await sock.sendMessage(chatId, { text }, quote ? { quoted: quote as WAMessage } : undefined);
    },
    async sendFile(chatId, file) {
      await sock.sendMessage(chatId, { document: file.data, mimetype: file.mimetype, fileName: file.fileName, caption: file.caption });
    },
    async sendImage(chatId, image) {
      await sock.sendMessage(chatId, { image: image.data, mimetype: image.mimetype, caption: image.caption });
    },
    async typing(chatId) {
      await sock.sendPresenceUpdate("composing", chatId).catch(() => {});
    },
    chatIdFor: (number) => `${number}@s.whatsapp.net`,
    async isOnWhatsApp(number) {
      const [result] = (await sock.onWhatsApp(number).catch(() => undefined)) ?? [];
      return result?.exists;
    },
    async setProfilePicture(image) {
      await sock.updateProfilePicture(jidNormalizedUser(sock.user!.id), image);
    },
  };

  /** Phone number (digits) behind a sender id; WhatsApp sometimes hides it behind a "LID". */
  async function phoneNumberOf(jid: string, alt: string | undefined): Promise<string> {
    if (alt && isPnUser(alt)) return jidDecode(alt)!.user;
    if (isLidUser(jid)) {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
      if (pn) return jidDecode(pn)!.user;
    }
    return jidDecode(jid)?.user ?? jid;
  }

  async function groupName(jid: string): Promise<string> {
    if (!groupNames.has(jid)) {
      const meta = await sock.groupMetadata(jid).catch(() => undefined);
      groupNames.set(jid, meta?.subject ?? "group");
    }
    return groupNames.get(jid)!;
  }

  function mediaOf(message: WAMessage, content: WAMessageContent | undefined): Media | undefined {
    const pick = (
      [
        ["image", content?.imageMessage],
        ["document", content?.documentMessage],
        ["audio", content?.audioMessage],
        ["video", content?.videoMessage],
        ["sticker", content?.stickerMessage],
      ] as const
    ).find(([, m]) => m);
    if (!pick) return undefined;
    const [kind, m] = pick;
    return {
      kind,
      mimetype: m!.mimetype ?? "application/octet-stream",
      fileName: "fileName" in m! ? (m.fileName ?? undefined) : undefined,
      size: m!.fileLength ? Number(m!.fileLength) : undefined,
      download: () => downloadMediaMessage(message, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage }),
    };
  }

  async function toIncoming(m: WAMessage): Promise<Incoming | undefined> {
    const chatId = m.key.remoteJid;
    if (!m.message || m.key.fromMe || !chatId || chatId.endsWith("@broadcast") || chatId.endsWith("@newsletter")) return;
    const content = normalizeMessageContent(m.message);
    if (!content || content.protocolMessage || content.reactionMessage) return;

    const isGroup = !!isJidGroup(chatId);
    const number = await phoneNumberOf(isGroup ? (m.key.participant ?? "") : chatId, isGroup ? m.key.participantAlt : m.key.remoteJidAlt);
    const contact = contactByNumber(number);
    const sender = { number, name: contact?.name ?? m.pushName ?? `+${number}`, isContact: !!contact };

    const info =
      content.extendedTextMessage?.contextInfo ??
      content.imageMessage?.contextInfo ??
      content.documentMessage?.contextInfo ??
      content.videoMessage?.contextInfo ??
      content.audioMessage?.contextInfo ??
      undefined;
    const me = [sock.user?.id, sock.user?.lid].filter((j): j is string => !!j).map((j) => jidNormalizedUser(j));
    const mentioned = !!info?.mentionedJid?.some((j) => me.includes(jidNormalizedUser(j)));
    const repliedToMe = !!info?.participant && me.includes(jidNormalizedUser(info.participant));

    let text = textOf(content);
    for (const jid of me) text = text.replace(new RegExp(`@${jidDecode(jid)!.user}\\b`, "g"), "");
    text = text.trim();
    const addressed = !isGroup || mentioned || repliedToMe || NAME_TRIGGER.test(text);

    // A question about a quoted photo/file ("@Friday what's this?") uses the quoted attachment.
    const quoted = normalizeMessageContent(info?.quotedMessage ?? undefined);
    let media = mediaOf(m, content);
    if (!media && quoted && info?.stanzaId) {
      media = mediaOf({ key: { remoteJid: chatId, id: info.stanzaId, participant: info.participant }, message: quoted }, quoted);
    }

    if (addressed && (isGroup || sender.isContact)) void sock.readMessages([m.key]).catch(() => {});

    return {
      chat: {
        chatId,
        isGroup,
        chatName: isGroup ? await groupName(chatId) : sender.name,
        sender,
        replyTo: isGroup ? m : undefined,
      },
      text,
      quoted: textOf(quoted) || undefined,
      media,
      addressed,
    };
  }

  async function connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.macOS("Chrome"), // a web-browser identity; linking by pairing code fails for "Desktop"
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    const current = sock;
    let pairingRequested = false;

    current.ev.on("creds.update", saveCreds);
    current.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr && config.pairingNumber && !pairingRequested) {
        pairingRequested = true;
        const code = await current.requestPairingCode(config.pairingNumber);
        console.log(`\n🔗 Pairing code: ${code}\nOn the bot's phone: WhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead".\n`);
      } else if (qr && !config.pairingNumber) {
        console.log("\n🔗 Scan this QR code with the bot's WhatsApp: Settings → Linked devices → Link a device\n");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "open") console.log(`✅ Connected to WhatsApp as +${jidDecode(current.user!.id)?.user}`);
      if (connection === "close") {
        const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          console.log("WhatsApp logged this device out. Clearing the old login; scan the new QR code to link again.");
          fs.rmSync(config.authDir, { recursive: true, force: true });
        } else {
          console.log(`WhatsApp connection closed (${status ?? "unknown reason"}), reconnecting…`);
        }
        setTimeout(() => void connect(), status === DisconnectReason.restartRequired ? 0 : 3000);
      }
    });
    current.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        toIncoming(m)
          .then((incoming) => incoming && onMessage(incoming, outbox))
          .catch((err) => console.error("Couldn't read an incoming message", err));
      }
    });
  }

  await connect();
  return outbox;
}
