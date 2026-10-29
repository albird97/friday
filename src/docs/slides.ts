import pptxgenjs from "pptxgenjs";

// pptxgenjs ships CommonJS-style typings for its ES module build; normalise the default export.
const PptxGenJS = ((pptxgenjs as { default?: unknown }).default ?? pptxgenjs) as typeof pptxgenjs.default;

export type Slide = { title: string; bullets?: string[]; table?: string[][]; notes?: string };

const ACCENT = "1F4E79";

export async function slidesToPptx(title: string, subtitle: string | undefined, slides: Slide[]): Promise<Buffer> {
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE";
  pres.title = title;

  const cover = pres.addSlide();
  cover.background = { color: ACCENT };
  cover.addText(title, { x: 0.8, y: 2.4, w: 11.7, h: 1.4, fontSize: 40, bold: true, color: "FFFFFF", fontFace: "Calibri" });
  if (subtitle) cover.addText(subtitle, { x: 0.8, y: 3.8, w: 11.7, h: 0.8, fontSize: 20, color: "D9E2EC", fontFace: "Calibri" });

  for (const s of slides) {
    const slide = pres.addSlide();
    slide.addShape("rect", { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: ACCENT } });
    slide.addText(s.title, { x: 0.6, y: 0.4, w: 12, h: 0.9, fontSize: 28, bold: true, color: ACCENT, fontFace: "Calibri" });

    const top = 1.5;
    if (s.bullets?.length) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.7, y: top, w: s.table ? 5.8 : 11.8, h: 5.4, fontSize: 18, color: "333333", valign: "top", paraSpaceAfter: 8, fontFace: "Calibri" },
      );
    }
    if (s.table?.length) {
      slide.addTable(
        s.table.map((row, i) => row.map((text) => ({ text, options: i === 0 ? { bold: true, color: "FFFFFF", fill: { color: ACCENT } } : {} }))),
        { x: s.bullets?.length ? 6.8 : 0.7, y: top, w: s.bullets?.length ? 5.9 : 11.8, fontSize: 12, border: { type: "solid", pt: 0.5, color: "CCCCCC" } },
      );
    }
    if (s.notes) slide.addNotes(s.notes);
  }

  return (await pres.write({ outputType: "nodebuffer" })) as Buffer;
}
