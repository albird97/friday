import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from "docx";
import { parseMarkdown, type Run } from "./markdown.js";

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];

function runs(list: Run[]): ParagraphChild[] {
  return list.map((r) => {
    const parts = r.text.split("\n");
    const textRuns = parts.map(
      (text, i) =>
        new TextRun({
          text,
          break: i > 0 ? 1 : undefined,
          bold: r.bold,
          italics: r.italic,
          strike: r.strike,
          font: r.code ? "Consolas" : undefined,
          shading: r.code ? { type: ShadingType.CLEAR, fill: "EEEEEE", color: "auto" } : undefined,
          style: r.link ? "Hyperlink" : undefined,
        }),
    );
    return r.link ? new ExternalHyperlink({ link: r.link, children: textRuns }) : textRuns;
  }).flat();
}

export async function markdownToDocx(title: string, markdown: string): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] })];

  for (const block of parseMarkdown(markdown)) {
    switch (block.type) {
      case "heading":
        children.push(new Paragraph({ heading: HEADINGS[Math.min(block.level, 4) - 1], children: runs(block.runs) }));
        break;
      case "paragraph":
        children.push(new Paragraph({ children: runs(block.runs), spacing: { after: 120 } }));
        break;
      case "list":
        for (const item of block.items) {
          children.push(
            item.label === "•"
              ? new Paragraph({ bullet: { level: Math.min(item.level, 8) }, children: runs(item.runs) })
              : new Paragraph({
                  indent: { left: 360 * (item.level + 1), hanging: 360 },
                  children: [new TextRun(`${item.label}\t`), ...runs(item.runs)],
                }),
          );
        }
        break;
      case "table":
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                tableHeader: true,
                children: block.header.map(
                  (cell) =>
                    new TableCell({
                      shading: { type: ShadingType.CLEAR, fill: "E8EEF5", color: "auto" },
                      children: [new Paragraph({ children: runs(cell.map((r) => ({ ...r, bold: true }))) })],
                    }),
                ),
              }),
              ...block.rows.map(
                (row) =>
                  new TableRow({
                    children: row.map((cell) => new TableCell({ children: [new Paragraph({ children: runs(cell) })] })),
                  }),
              ),
            ],
          }),
          new Paragraph({ text: "" }),
        );
        break;
      case "code":
        for (const line of block.text.split("\n")) {
          children.push(
            new Paragraph({
              shading: { type: ShadingType.CLEAR, fill: "F4F4F4", color: "auto" },
              children: [new TextRun({ text: line, font: "Consolas", size: 18 })],
            }),
          );
        }
        break;
      case "quote":
        children.push(
          new Paragraph({
            indent: { left: 480 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: "BBBBBB", space: 8 } },
            children: runs(block.runs.map((r) => ({ ...r, italic: true }))),
          }),
        );
        break;
      case "rule":
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BBBBBB", space: 1 } },
            children: [],
          }),
        );
        break;
    }
  }

  const doc = new Document({
    creator: "Friday",
    title,
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
