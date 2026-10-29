export type Sender = {
  number: string; // digits only, e.g. "6281234567890"
  name: string;
  isContact: boolean; // a known contact (ALLOWED_CONTACTS or added with /add)
};

export type ChatContext = {
  chatId: string; // WhatsApp JID of the chat (private or group), or "cli" in terminal mode
  isGroup: boolean;
  chatName: string; // group subject, or the other person's name in a private chat
  sender: Sender;
  /** Platform message to quote when replying (used in groups so it's clear who Friday answers). */
  replyTo?: unknown;
};

export type OutgoingFile = {
  data: Buffer;
  fileName: string;
  mimetype: string;
  caption?: string;
};

/** Where replies go: WhatsApp in production, the terminal in `npm run chat`. */
export interface Outbox {
  sendText(chatId: string, text: string, quote?: unknown): Promise<void>;
  sendFile(chatId: string, file: OutgoingFile): Promise<void>;
  sendImage(chatId: string, image: { data: Buffer; mimetype: string; caption?: string }): Promise<void>;
  /** Shows "typing…" in the chat; best-effort. */
  typing(chatId: string): Promise<void>;
  /** The private-chat id for a phone number. */
  chatIdFor(number: string): string;
  /** Whether a number has WhatsApp; undefined when it couldn't be checked (or the channel can't tell). */
  isOnWhatsApp?(number: string): Promise<boolean | undefined>;
  /** Replaces the bot's own profile picture (WhatsApp only). */
  setProfilePicture?(image: Buffer): Promise<void>;
}
