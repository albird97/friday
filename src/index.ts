import { handleIncoming, idle, runScheduledTask } from "./bot.js";
import { config } from "./config.js";
import { imageProvider, pruneImages } from "./images.js";
import { hideSignalSessionDumps, keepRecentProblems } from "./logging.js";
import { chatModels, currentModel, familyOf, latestModel, setChatModel, setModel, type Family } from "./model.js";
import { pruneMonitor } from "./monitor.js";
import { startReminderLoop } from "./reminders.js";
import { startWeb } from "./web.js";
import { expireChatSessions, expireSession } from "./session.js";
import { onUsageAlert } from "./usage.js";
import { startWhatsApp } from "./whatsapp.js";

keepRecentProblems();
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
pruneMonitor();
setInterval(() => pruneMonitor(), 24 * 3600_000).unref();
const outbox = await startWhatsApp((msg, out) => void handleIncoming(msg, out));
startReminderLoop(outbox, undefined, (task) => runScheduledTask(task, outbox));
if (config.PUBLIC_URL) startWeb(outbox);
onUsageAlert(async (text) => {
  const admin = config.contacts[0];
  if (admin) await outbox.sendText(outbox.chatIdFor(admin.number), text);
});

/** Moves every chosen model family to its newer version as soon as one comes out, and tells the admin about the default. */
async function followNewestModel(): Promise<void> {
  const lookups = new Map<Family, Promise<string | undefined>>();
  const newestFor = async (model: string) => {
    const family = familyOf(model);
    if (!family) return undefined;
    if (!lookups.has(family)) {
      const lookup = latestModel(family).catch((err) => {
        console.warn(`Couldn't look up the newest ${family} model:`, err instanceof Error ? err.message : err);
        return undefined;
      });
      lookups.set(family, lookup);
    }
    return lookups.get(family);
  };

  for (const own of chatModels()) {
    const newest = await newestFor(own.model);
    if (!newest || newest === own.model) continue;
    setChatModel(own.chatId, newest);
    expireSession(own.chatId);
  }

  const model = currentModel();
  const newest = await newestFor(model);
  if (!newest || newest === model) return;
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
