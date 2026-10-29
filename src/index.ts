import { handleIncoming, idle } from "./bot.js";
import { config } from "./config.js";
import { imageProvider, pruneImages } from "./images.js";
import { hideSignalSessionDumps } from "./logging.js";
import { startReminderLoop } from "./reminders.js";
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
  `Starting ${config.BOT_NAME} (${config.FRIDAY_MODEL}, effort ${config.FRIDAY_EFFORT}, timezone ${config.TIMEZONE}, images: ${imageProvider ?? "off"})`,
);
pruneImages();
const outbox = await startWhatsApp((msg, out) => void handleIncoming(msg, out));
startReminderLoop(outbox);

// A restart (deploy, update) waits for replies in progress instead of cutting them off mid-answer. systemd allows 90 s.
process.once("SIGTERM", () => {
  console.log("Stopping: finishing replies in progress…");
  void Promise.race([idle(), new Promise((resolve) => setTimeout(resolve, 80_000))]).then(() => process.exit(0));
});
