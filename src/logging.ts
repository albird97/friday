// libsignal (WhatsApp's encryption, used by Baileys) prints whole session records, private keys included, whenever
// it opens or closes a session. Drop those lines so keys never end up in a terminal or the server's system log.
const SESSION_DUMPS = ["Closing session", "Opening session", "Removing old closed session", "Session already closed"];

export function hideSignalSessionDumps(): void {
  for (const level of ["info", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const [first] = args;
      if (typeof first === "string" && SESSION_DUMPS.some((prefix) => first.startsWith(prefix))) return;
      original(...args);
    };
  }
}
