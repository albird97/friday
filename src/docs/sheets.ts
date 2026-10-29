import ExcelJS from "exceljs";

export type Cell = string | number | boolean | null;
export type Sheet = { name: string; rows: Cell[][] };

/** First row of each sheet is treated as the header. Strings starting with "=" become formulas. */
export async function sheetsToXlsx(sheets: Sheet[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Friday";

  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet");
    for (const row of sheet.rows) {
      ws.addRow(row.map((v) => (typeof v === "string" && v.startsWith("=") ? { formula: v.slice(1) } : v)));
    }
    if (sheet.rows.length === 0) continue;

    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    const width = Math.max(...sheet.rows.map((r) => r.length));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: width } };
    for (let c = 1; c <= width; c++) {
      const longest = Math.max(...sheet.rows.map((r) => String(r[c - 1] ?? "").length));
      ws.getColumn(c).width = Math.min(Math.max(longest + 2, 8), 60);
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function sheetToCsv(sheet: Sheet): Buffer {
  const escape = (v: Cell) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return Buffer.from(sheet.rows.map((row) => row.map(escape).join(",")).join("\n") + "\n");
}
