import { createRequire } from "node:module";
import path from "node:path";
import pdfmake from "pdfmake";
import type { CanvasElement, Content, ContentText, TDocumentDefinitions } from "pdfmake/interfaces.js";
import { parseMarkdown, type Run } from "./markdown.js";

const require = createRequire(import.meta.url);
const fontDir = path.join(path.dirname(require.resolve("pdfmake/package.json")), "fonts", "Roboto");
pdfmake.setFonts({
  Roboto: {
    normal: path.join(fontDir, "Roboto-Regular.ttf"),
    bold: path.join(fontDir, "Roboto-Medium.ttf"),
    italics: path.join(fontDir, "Roboto-Italic.ttf"),
    bolditalics: path.join(fontDir, "Roboto-MediumItalic.ttf"),
  },
});
pdfmake.setUrlAccessPolicy(() => false); // never fetch remote resources while rendering
pdfmake.setLocalAccessPolicy((file) => file.startsWith(fontDir));

const ACCENT = "#1f4e79";

// Roboto has no emoji, arrow or checkbox glyphs; swap or drop them rather than print empty boxes.
const SUBSTITUTES: Record<string, string> = { "→": "->", "←": "<-", "⇒": "=>", "☐": "[ ]", "☑": "[x]", "✓": "[x]", "✔": "[x]", "✗": "x", "✘": "x" };
const strip = (text: string) =>
  text
    .replace(/[→←⇒☐☑✓✔✗✘]/g, (c) => SUBSTITUTES[c])
    .replace(/\s*[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+/gu, "");

function runs(list: Run[]): ContentText[] {
  return list.map((r) => ({
    text: strip(r.text),
    bold: r.bold,
    italics: r.italic,
    decoration: r.strike ? "lineThrough" : r.link ? "underline" : undefined,
    link: r.link,
    color: r.link ? ACCENT : undefined,
    background: r.code ? "#eeeeee" : undefined,
  }));
}

/** A drawn checkbox for "- [ ]" / "- [x]" items (the font has no ballot-box glyphs). */
function checkbox(checked: boolean): CanvasElement[] {
  const box: CanvasElement = { type: "rect", x: 0, y: 3, w: 8.5, h: 8.5, r: 1.5, lineWidth: 0.9, lineColor: "#555555" };
  const tick: CanvasElement = { type: "polyline", points: [{ x: 1.8, y: 7.3 }, { x: 3.8, y: 9.5 }, { x: 7, y: 4.8 }], lineWidth: 1.3, lineColor: ACCENT };
  return checked ? [box, tick] : [box];
}

export async function markdownToPdf(title: string, markdown: string): Promise<Buffer> {
  const content: Content[] = [{ text: strip(title), style: "title" }];

  for (const block of parseMarkdown(markdown)) {
    switch (block.type) {
      case "heading":
        content.push({ text: runs(block.runs), style: `h${Math.min(block.level, 3)}` });
        break;
      case "paragraph":
        content.push({ text: runs(block.runs), margin: [0, 0, 0, 8] });
        break;
      case "list":
        for (const item of block.items) {
          const isTask = item.label === "☐" || item.label === "☑";
          content.push({
            columns: [
              isTask ? { canvas: checkbox(item.label === "☑"), width: 16 } : { text: item.label, width: 16 },
              { text: runs(item.runs), width: "*" },
            ],
            margin: [item.level * 16, 0, 0, 3],
          });
        }
        content.push({ text: "", margin: [0, 0, 0, 6] });
        break;
      case "table":
        content.push({
          table: {
            headerRows: 1,
            widths: block.header.map(() => "*"),
            body: [
              block.header.map((cell) => ({ text: runs(cell), bold: true, fillColor: "#e8eef5" })),
              ...block.rows.map((row) => row.map((cell) => ({ text: runs(cell) }))),
            ],
          },
          layout: "lightHorizontalLines",
          fontSize: 9.5,
          margin: [0, 2, 0, 10],
        });
        break;
      case "code":
        content.push({
          table: { widths: ["*"], body: [[{ text: strip(block.text), fontSize: 8.5, preserveLeadingSpaces: true }]] },
          layout: { fillColor: () => "#f4f4f4", hLineWidth: () => 0, vLineWidth: () => 0 },
          margin: [0, 2, 0, 10],
        });
        break;
      case "quote":
        content.push({ text: runs(block.runs), italics: true, color: "#555555", margin: [16, 0, 0, 8] });
        break;
      case "rule":
        content.push({
          canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#bbbbbb" }],
          margin: [0, 4, 0, 10],
        });
        break;
    }
  }

  const doc: TDocumentDefinitions = {
    info: { title, creator: "Friday" },
    pageSize: "A4",
    pageMargins: [40, 50, 40, 50],
    content,
    defaultStyle: { font: "Roboto", fontSize: 10.5, lineHeight: 1.25 },
    styles: {
      title: { fontSize: 22, bold: true, color: ACCENT, margin: [0, 0, 0, 14] },
      h1: { fontSize: 16, bold: true, color: ACCENT, margin: [0, 10, 0, 6] },
      h2: { fontSize: 13.5, bold: true, color: ACCENT, margin: [0, 8, 0, 4] },
      h3: { fontSize: 11.5, bold: true, margin: [0, 6, 0, 3] },
    },
    footer: (page, pages) => ({
      text: `${page} / ${pages}`,
      alignment: "center",
      fontSize: 8,
      color: "#888888",
      margin: [0, 20, 0, 0],
    }),
  };

  return Buffer.from(await pdfmake.createPdf(doc).getBuffer());
}
