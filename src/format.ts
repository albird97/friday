/** Converts stray Markdown into WhatsApp formatting, leaving code blocks untouched. */
export function toWhatsApp(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/^#{1,6}\s+(.+)$/gm, "*$1*") // headings → bold line
            .replace(/\*\*(.+?)\*\*/g, "*$1*") // **bold** → *bold*
            .replace(/__(.+?)__/g, "_$1_")
            .replace(/~~(.+?)~~/g, "~$1~")
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => (label === url ? url : `${label} (${url})`))
            .replace(/^(\s*)[*+]\s+/gm, "$1- "), // "* item" would toggle bold in WhatsApp
    )
    .join("")
    .trim();
}

/** Splits long text into WhatsApp-sized chunks, preferring paragraph and line breaks. */
export function chunk(text: string, max = 3500): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
