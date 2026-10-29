import { marked, type Token, type Tokens } from "marked";

/** A small, renderer-neutral view of Markdown that the PDF and Word writers share. */
export type Run = { text: string; bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; link?: string };
export type ListItem = { runs: Run[]; level: number; label: string };
export type Block =
  | { type: "heading"; level: number; runs: Run[] }
  | { type: "paragraph"; runs: Run[] }
  | { type: "list"; items: ListItem[] }
  | { type: "table"; header: Run[][]; rows: Run[][][] }
  | { type: "code"; text: string }
  | { type: "quote"; runs: Run[] }
  | { type: "rule" };

type Style = Omit<Run, "text">;

function inline(tokens: Token[] | undefined, style: Style = {}): Run[] {
  const runs: Run[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "strong":
        runs.push(...inline((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        runs.push(...inline((token as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case "del":
        runs.push(...inline((token as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case "codespan":
        runs.push({ ...style, text: decode((token as Tokens.Codespan).text), code: true });
        break;
      case "link":
        runs.push(...inline((token as Tokens.Link).tokens, { ...style, link: (token as Tokens.Link).href }));
        break;
      case "br":
        runs.push({ ...style, text: "\n" });
        break;
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens?.length) runs.push(...inline(t.tokens, style));
        else runs.push({ ...style, text: decode(t.text) });
        break;
      }
      default:
        if ("text" in token && typeof token.text === "string") runs.push({ ...style, text: decode(token.text) });
    }
  }
  return runs;
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function listItems(list: Tokens.List, level: number, out: ListItem[]): void {
  const start = typeof list.start === "number" ? list.start : 1;
  list.items.forEach((item, i) => {
    const runs: Run[] = [];
    const nested: Tokens.List[] = [];
    for (const child of item.tokens) {
      if (child.type === "list") nested.push(child as Tokens.List);
      else if (child.type === "text" || child.type === "paragraph") {
        if (runs.length) runs.push({ text: " " });
        runs.push(...inline((child as Tokens.Text).tokens ?? [child]));
      }
    }
    const label = item.task ? (item.checked ? "☑" : "☐") : list.ordered ? `${start + i}.` : "•";
    out.push({ runs, level, label });
    for (const sub of nested) listItems(sub, level + 1, out);
  });
}

export function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const token of marked.lexer(markdown)) {
    switch (token.type) {
      case "heading":
        blocks.push({ type: "heading", level: (token as Tokens.Heading).depth, runs: inline(token.tokens) });
        break;
      case "paragraph":
        blocks.push({ type: "paragraph", runs: inline(token.tokens) });
        break;
      case "list": {
        const items: ListItem[] = [];
        listItems(token as Tokens.List, 0, items);
        blocks.push({ type: "list", items });
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        blocks.push({
          type: "table",
          header: table.header.map((cell) => inline(cell.tokens)),
          rows: table.rows.map((row) => row.map((cell) => inline(cell.tokens))),
        });
        break;
      }
      case "code":
        blocks.push({ type: "code", text: (token as Tokens.Code).text });
        break;
      case "blockquote":
        blocks.push({ type: "quote", runs: inline((token as Tokens.Blockquote).tokens.flatMap((t) => ("tokens" in t ? (t.tokens ?? []) : [t]))) });
        break;
      case "hr":
        blocks.push({ type: "rule" });
        break;
      case "text":
        blocks.push({ type: "paragraph", runs: inline((token as Tokens.Text).tokens ?? [token]) });
        break;
    }
  }
  return blocks;
}
