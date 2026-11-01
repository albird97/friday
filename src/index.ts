import { handleIncoming, idle } from "./bot.js";
import { config } from "./config.js";
import { imageProvider, pruneImages } from "./images.js";
import { hideSignalSessionDumps } from "./logging.js";
import { currentModel, familyOf, latestModel, setModel } from "./model.js";
import { startReminderLoop } from "./reminders.js";
import { startWeb } from "./web.js";
import { expireChatSessions } from "./session.js";
import { onUsageAlert } from "./usage.js";
import { startWhatsApp } from "./whatsapp.js";

hideSignalSessionDumps();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is missing. Copy .env.example to .env and paste your Claude API key into it.");
  process.exit(1);
}
if (config.contacts.length === 0) {
  console.warn("ALLOWED_CONTACTS is empty, so nobody can message Friday privately. Add your number to .env.");
}

console.log(
  `Starting ${config.BOT_NAME} (${currentModel()}, effort ${config.FRIDAY_EFFORT}, timezone ${config.TIMEZONE}, images: ${imageProvider ?? "off"})`,
);
pruneImages();
const outbox = await startWhatsApp((msg, out) => void handleIncoming(msg, out));
startReminderLoop(outbox);
if (config.PUBLIC_URL) startWeb(outbox);
onUsageAlert(async (text) => {
  const admin = config.contacts[0];
  if (admin) await outbox.sendText(outbox.chatIdFor(admin.number), text);
});

/** Moves to a newer version of the current model family as soon as one comes out, and tells the admin. */
async function followNewestModel(): Promise<void> {
  const model = currentModel();
  const family = familyOf(model);
  if (!family) return;
  const newest = await latestModel(family).catch((err) => {
    console.warn(`Couldn't look up the newest ${family} model:`, err instanceof Error ? err.message : err);
    return model;
  });
  if (newest === model) return;
  setModel(newest);
  expireChatSessions();
  console.log(`Model updated: ${model} -> ${newest}`);
  const admin = config.contacts[0];
  if (admin) await outbox.sendText(outbox.chatIdFor(admin.number), `🧠 Model diperbarui ke versi terbaru: *${newest}* (sebelumnya ${model}).`).catch(() => {});
}
void followNewestModel();
setInterval(() => void followNewestModel(), 24 * 3600_000).unref();

// A restart (deploy, update) waits for replies in progress instead of cutting them off mid-answer. systemd allows 90 s.
process.once("SIGTERM", () => {
  console.log("Stopping: finishing replies in progress…");
  void Promise.race([idle(), new Promise((resolve) => setTimeout(resolve, 80_000))]).then(() => process.exit(0));
});
