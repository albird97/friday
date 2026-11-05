// libsignal (WhatsApp's encryption, used by Baileys) prints whole session records, private keys included, whenever
// it opens or closes a session. Drop those lines so keys never end up in a terminal or the server's system log.
const SESSION_DUMPS = ["Closing session", "Opening session", "Removing old closed session", "Session already closed"];
const isSessionDump = (first: unknown) => typeof first === "string" && SESSION_DUMPS.some((prefix) => first.startsWith(prefix));

export function hideSignalSessionDumps(): void {
  for (const level of ["info", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (isSessionDump(args[0])) return;
      original(...args);
    };
  }
}

// The last errors and warnings, kept in memory (gone on restart) for the dashboard's problem log. One line each,
// shortened, with anything shaped like a key or token blanked out.

export type Problem = { at: number; level: "error" | "warn"; text: string };

const MAX_PROBLEMS = 200;
const MAX_CHARS = 400;
const problems: Problem[] = [];

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** One readable line: the message, without stack traces, long secrets or line breaks. */
export function problemText(args: unknown[]): string {
  const text = args
    .map(describe)
    .join(" ")
    .replace(/\b[A-Za-z0-9_\-+/=]{40,}\b/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
}

/** Starts keeping console.error and console.warn lines for the dashboard. Safe to call once at startup. */
export function keepRecentProblems(): void {
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      if (isSessionDump(args[0])) return;
      problems.push({ at: Date.now(), level, text: problemText(args) });
      if (problems.length > MAX_PROBLEMS) problems.shift();
    };
  }
}

/** Newest first. */
export function recentProblems(): Problem[] {
  return [...problems].reverse();
}
