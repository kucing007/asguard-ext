import * as XLSX from "xlsx";

export interface ParsedExcel {
  headers: string[];
  rows: Record<string, string>[];
  sheetName: string;
  rowCount: number;
}

function cellToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    // Whole numbers: drop the .0 (mirrors Python _value_to_str)
    return Number.isInteger(v) ? String(v) : String(v);
  }
  return String(v);
}

export async function parseExcel(file: File): Promise<ParsedExcel> {
  const ab = await file.arrayBuffer();
  const wb = XLSX.read(ab, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];

  // sheet_to_json with header:1 gives rows as arrays; row 0 = headers
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });

  if (rawRows.length === 0) {
    return { headers: [], rows: [], sheetName, rowCount: 0 };
  }

  const headers = (rawRows[0] as unknown[]).map((h, i) =>
    h != null && String(h).trim() ? String(h).trim() : `Col${i + 1}`,
  );

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < rawRows.length; i++) {
    const raw = rawRows[i] as unknown[];
    const row: Record<string, string> = { _row: String(i) };
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cellToString(raw[j]);
    }
    rows.push(row);
  }

  return { headers, rows, sheetName, rowCount: rows.length };
}
