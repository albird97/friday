import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import makeWASocket, {
  Browsers,
  decryptPollVote,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getUrlFromDirectPath,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  sha256,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageContent,
  type WASocket,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import type { Incoming, Media } from "./bot.js";
import type { CatalogItem, Product as CatalogProduct } from "./catalog.js";
import { config } from "./config.js";
import { contactByNumber, isAdmin } from "./contacts.js";
import { pollByMessage, recordVote, type Poll } from "./polls.js";
import { loadSession } from "./session.js";
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

/**
 * The options someone chose in one of our polls, or undefined if the vote can't be read. A vote is encrypted for the
 * poll's and the voter's ids, and WhatsApp may use either a phone-number id or a LID for each, so every pair is tried.
 */
export function readVote(
  vote: { encPayload?: Uint8Array | null; encIv?: Uint8Array | null },
  poll: Poll,
  creatorIds: string[],
  voterIds: string[],
): string[] | undefined {
  if (!vote.encPayload || !vote.encIv) return undefined;
  for (const pollCreatorJid of creatorIds) {
    for (const voterJid of voterIds) {
      try {
        const { selectedOptions } = decryptPollVote(
          { encPayload: vote.encPayload, encIv: vote.encIv },
          { pollCreatorJid, pollMsgId: poll.msg_id, pollEncKey: poll.secret, voterJid },
        );
        const chosen = (selectedOptions ?? []).map((hash) => Buffer.from(hash));
        return poll.options.filter((option) => chosen.some((hash) => hash.equals(sha256(Buffer.from(option)))));
      } catch {
        // wrong pair of ids: the decryption check fails, try the next
      }
    }
  }
  return undefined;
}

// Catalog items list features, not goods: no price (WhatsApp then shows none) and no country of origin.
const toProduct = (item: CatalogItem, image: { url: string }) =>
  ({ name: item.name, description: item.description, retailerId: item.id, images: [image] }) as unknown as Parameters<WASocket["productUpdate"]>[1];
const fromProduct = (p: Awaited<ReturnType<WASocket["productCreate"]>>): CatalogProduct => ({
  id: p.id,
  retailerId: p.retailerId,
  name: p.name,
  description: p.description,
  status: p.reviewStatus?.whatsapp,
});

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
    async sendPoll(chatId, poll) {
      const secret = randomBytes(32);
      const sent = await sock.sendMessage(chatId, {
        poll: { name: poll.question, values: poll.options, selectableCount: poll.multiple ? 0 : 1, messageSecret: secret },
      });
      if (!sent?.key.id) throw new Error("WhatsApp didn't accept the poll.");
      return { messageId: sent.key.id, secret };
    },
    async groupSize(chatId) {
      const meta = await sock.groupMetadata(chatId).catch(() => undefined);
      return meta ? meta.participants.length - 1 : undefined;
    },
    catalog: {
      async list() {
        const { products } = await sock.getCatalog({ limit: 100 });
        return products.map(fromProduct);
      },
      async create(item, image) {
        return fromProduct(await sock.productCreate({ ...toProduct(item, await uploadCatalogImage(image)), originCountryCode: undefined }));
      },
      async update(productId, item, image) {
        return fromProduct(await sock.productUpdate(productId, toProduct(item, await uploadCatalogImage(image))));
      },
    },
  };

  /**
   * Uploads a catalog picture ourselves: Baileys' own product upload sends its temp file before writing it out, so
   * WhatsApp gets an empty file. A finished .whatsapp.net URL makes Baileys skip its upload.
   */
  async function uploadCatalogImage(image: Buffer): Promise<{ url: string }> {
    const file = path.join(os.tmpdir(), `friday-catalog-${randomBytes(8).toString("hex")}`);
    fs.writeFileSync(file, image);
    try {
      const { directPath } = await sock.waUploadToServer(file, {
        mediaType: "product-catalog-image",
        fileEncSha256B64: createHash("sha256").update(image).digest("base64"),
        timeoutMs: 30_000,
      });
      return { url: getUrlFromDirectPath(directPath) };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

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

  /** A vote in one of our polls: stored without involving Claude (or answering it). */
  async function saveVote(m: WAMessage, update: NonNullable<WAMessageContent["pollUpdateMessage"]>): Promise<void> {
    const poll = update.pollCreationMessageKey?.id ? pollByMessage(update.pollCreationMessageKey.id) : undefined;
    const chatId = m.key.remoteJid;
    if (!poll || !update.vote || !chatId || poll.chat_id !== chatId) return;
    const isGroup = !!isJidGroup(chatId);
    const ids = (jids: (string | null | undefined)[]) => [...new Set(jids.filter((j): j is string => !!j).map((j) => jidNormalizedUser(j)))];
    const choices = readVote(
      update.vote,
      poll,
      ids([sock.user?.id, sock.user?.lid]),
      ids(isGroup ? [m.key.participant, m.key.participantAlt] : [m.key.remoteJid, m.key.remoteJidAlt]),
    );
    if (!choices) {
      console.error(`Couldn't read a vote in poll #${poll.id}`);
      return;
    }
    const number = await phoneNumberOf(isGroup ? (m.key.participant ?? "") : chatId, isGroup ? m.key.participantAlt : m.key.remoteJidAlt);
    recordVote(poll.id, number, m.pushName ?? undefined, choices);
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
    // Only the admin may add Friday to groups: anyone else's group is left at once (every message there costs Claude
    // credit). Both events can report the same add, so each group is handled once.
    const isMe = (jid: string | undefined) =>
      !!jid && [current.user?.id, current.user?.lid].some((me) => me && jidNormalizedUser(me) === jidNormalizedUser(jid));
    const guarded = new Set<string>();
    async function guardGroup(groupId: string, author: string | undefined, authorPn: string | undefined) {
      if (!author || guarded.has(groupId)) return; // unknown adder (e.g. a resync of an old group): leave it alone
      guarded.add(groupId);
      const adder = await phoneNumberOf(author, authorPn);
      if (isAdmin(adder)) return;
      const name = await groupName(groupId);
      console.log(`+${adder} added me to the group "${name}"; leaving, since only the admin may add me to groups.`);
      await current.sendMessage(groupId, { text: `Maaf, saya hanya bisa ditambahkan ke grup oleh pemilik saya. Saya keluar dulu ya. 👋` }).catch(() => {});
      await current.groupLeave(groupId).catch((err) => console.error(`Couldn't leave "${name}"`, err));
      const admin = config.contacts[0];
      if (admin) {
        const who = contactByNumber(adder)?.name ?? `+${adder}`;
        await outbox.sendText(outbox.chatIdFor(admin.number), `⚠️ ${who} menambahkan saya ke grup "${name}". Saya sudah keluar. Kalau grup itu memang boleh, tambahkan saya sendiri.`).catch(() => {});
      }
    }
    current.ev.on("group-participants.update", ({ id, author, authorPn, participants, action }) => {
      if (action === "add" && participants.some((p) => isMe(p.id) || isMe(p.phoneNumber) || isMe(p.lid))) void guardGroup(id, author, authorPn);
    });
    current.ev.on("groups.upsert", (groups) => {
      // This also fires when WhatsApp resends info about groups Friday is already in; never leave one it has talked in.
      for (const g of groups) if (!loadSession(g.id)) void guardGroup(g.id, g.author, g.authorPn);
    });

    current.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        const vote = m.key.fromMe ? undefined : normalizeMessageContent(m.message)?.pollUpdateMessage;
        if (vote) {
          saveVote(m, vote).catch((err) => console.error("Couldn't save a poll vote", err));
          continue;
        }
        toIncoming(m)
          .then((incoming) => incoming && onMessage(incoming, outbox))
          .catch((err) => console.error("Couldn't read an incoming message", err));
      }
    });
  }

  await connect();
  return outbox;
}
