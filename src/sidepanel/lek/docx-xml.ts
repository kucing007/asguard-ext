import PizZip from "pizzip";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

export interface LoadedDoc {
  zip: PizZip;
  doc: Document; // parsed word/document.xml
}

/** Local name of an element, namespace-agnostic (works in browser + xmldom). */
function ln(el: Element | Node): string {
  const anyEl = el as Element & { localName?: string; nodeName?: string; tagName?: string };
  if (anyEl.localName) return anyEl.localName;
  const name = anyEl.nodeName ?? anyEl.tagName ?? "";
  return name.includes("}") ? (name.split("}").pop() ?? name) : name.replace(/^[^:]*:/, "");
}

/** Element children of `parent` (childNodes-based for DOM-impl portability). */
function children(parent: Element): Element[] {
  return Array.from(parent.childNodes).filter((n): n is Element => n.nodeType === 1);
}

/** Element children of `parent` whose local name equals `name`. */
function childrenByName(parent: Element, name: string): Element[] {
  return children(parent).filter((c) => ln(c) === name);
}

/** First element child of `parent` with local name `name`, or null. */
function child(parent: Element, name: string): Element | null {
  return childrenByName(parent, name)[0] ?? null;
}

/** Parse a .docx ArrayBuffer into the document.xml DOM + the PizZip archive. */
export function loadDoc(buf: ArrayBuffer | Uint8Array): LoadedDoc {
  const data = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let zip: PizZip;
  let xml: string | undefined;
  try {
    zip = new PizZip(data);
    xml = zip.file("word/document.xml")?.asText();
  } catch {
    throw new Error("File bukan .docx valid.");
  }
  if (!xml) throw new Error("File bukan .docx valid (document.xml tidak ditemukan).");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return { zip, doc };
}

/** Serialize the mutated document.xml back into a new .docx as Uint8Array. */
export function serializeDoc(loaded: LoadedDoc): Uint8Array {
  const xml = new XMLSerializer().serializeToString(loaded.doc);
  loaded.zip.file("word/document.xml", xml);
  return loaded.zip.generate({ type: "uint8array" });
}

/** The <w:body> element. */
export function bodyEl(doc: Document): Element {
  const b = childrenByName(doc.documentElement, "body")[0];
  if (!b) throw new Error("document.xml tidak memiliki <w:body>.");
  return b;
}

/** Body-level <w:tbl> elements, in document order (python-docx doc.tables). */
export function bodyTables(doc: Document): Element[] {
  return childrenByName(bodyEl(doc), "tbl");
}

/** Body-level <w:p> elements, in document order (python-docx doc.paragraphs). */
export function bodyParagraphs(doc: Document): Element[] {
  return childrenByName(bodyEl(doc), "p");
}

/** Rows (<w:tr>) of a <w:tbl>, in order. */
export function tableRows(tbl: Element): Element[] {
  return childrenByName(tbl, "tr");
}

/** Column count from <w:tblGrid><w:gridCol/> (python-docx len(table.columns)). */
export function tableColumns(tbl: Element): number {
  const grid = child(tbl, "tblGrid");
  if (grid) return childrenByName(grid, "gridCol").length || 1;
  return Math.max(1, ...tableRows(tbl).map((tr) => rowCells(tr).length));
}

/** gridSpan value of a <w:tc> (default 1). */
function gridSpan(tc: Element): number {
  const tcPr = child(tc, "tcPr");
  if (!tcPr) return 1;
  const gs = child(tcPr, "gridSpan");
  if (!gs) return 1;
  const v = gs.getAttribute("w:val") ?? gs.getAttributeNS(W, "val");
  const n = v ? parseInt(v, 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Cells of a row, expanded by gridSpan to match python-docx row.cells
 * (a merged cell appears once per spanned grid column).
 */
export function rowCells(tr: Element): Element[] {
  const out: Element[] = [];
  for (const tc of childrenByName(tr, "tc")) {
    const span = gridSpan(tc);
    for (let i = 0; i < span; i++) out.push(tc);
  }
  return out;
}

/** Text of a <w:r>: concatenation of its <w:t> children (python-docx Run.text-ish). */
function runText(r: Element): string {
  let s = "";
  for (const t of childrenByName(r, "t")) s += t.textContent ?? "";
  return s;
}

/** Paragraph text: concat of direct-child runs' text (python-docx Paragraph.text). */
export function paraText(p: Element): string {
  return childrenByName(p, "r").map(runText).join("");
}

/** Cell text: paragraphs joined by "\n" (python-docx Cell.text). */
export function cellText(tc: Element): string {
  return childrenByName(tc, "p").map(paraText).join("\n");
}

/**
 * Flow paragraph text: direct-child runs, FIRST <w:t> only (matches Python
 * get_paragraph_text). Used for section-matching text.
 */
export function flowParaText(p: Element): string {
  let s = "";
  for (const r of childrenByName(p, "r")) {
    const t = child(r, "t");
    if (t && t.textContent) s += t.textContent;
  }
  return s.trim();
}

/** Header tuple of a table (first-row cells, stripped, \n->space, [:50]). */
export function getTableHeader(tbl: Element): string[] {
  const rows = tableRows(tbl);
  if (!rows.length) return [];
  return rowCells(rows[0]).map((tc) =>
    cellText(tc).trim().replace(/\n/g, " ").slice(0, 50),
  );
}

// ---- Mutation helpers (python-docx oxml equivalents) ----

function setRunText(r: Element, text: string): void {
  const ts = childrenByName(r, "t");
  if (ts.length) {
    ts[0].textContent = text;
    for (const t of ts.slice(1)) r.removeChild(t);
  } else {
    const t = (r.ownerDocument as Document).createElementNS(W, "w:t");
    t.setAttributeNS(XML_NS, "space", "preserve");
    t.textContent = text;
    r.appendChild(t);
  }
}

/** Blank a run's text (keep one empty <w:t>, drop extras) — python-docx run.text="". */
function setRunTextBlank(r: Element): void {
  const ts = childrenByName(r, "t");
  if (ts.length) {
    ts[0].textContent = "";
    for (const t of ts.slice(1)) r.removeChild(t);
  }
}

function appendRunWithText(parent: Element, text: string): void {
  const doc = parent.ownerDocument as Document;
  const r = doc.createElementNS(W, "w:r");
  const t = doc.createElementNS(W, "w:t");
  t.setAttributeNS(XML_NS, "space", "preserve");
  t.textContent = text;
  r.appendChild(t);
  parent.appendChild(r);
}

/** Set a cell's text, preserving the first run's formatting (python-docx set_cell_text). */
export function setCellText(tc: Element, text: string): void {
  const ps = childrenByName(tc, "p");
  const p = ps[0];
  if (!p) {
    const newP = (tc.ownerDocument as Document).createElementNS(W, "w:p");
    tc.appendChild(newP);
    appendRunWithText(newP, text);
    return;
  }
  const runs = childrenByName(p, "r");
  if (runs.length) {
    setRunText(runs[0], String(text));
    for (const r of runs.slice(1)) setRunTextBlank(r);
  } else {
    appendRunWithText(p, String(text));
    // python-docx removes extra paragraphs only in the no-runs branch.
    for (const extra of ps.slice(1)) tc.removeChild(extra);
  }
}

/** Deep-clone the last row, blank its cell texts, append to table; return new row. */
export function cloneAndAppendRow(tbl: Element): Element {
  const rows = tableRows(tbl);
  const ref = rows[rows.length - 1];
  if (!ref) throw new Error("Tidak bisa menambah baris pada tabel tanpa baris.");
  const newTr = ref.cloneNode(true) as Element;
  for (const tc of childrenByName(newTr, "tc")) {
    for (const p of childrenByName(tc, "p")) {
      for (const r of childrenByName(p, "r")) {
        const t = child(r, "t");
        if (t) t.textContent = "";
      }
    }
  }
  tbl.appendChild(newTr);
  return newTr;
}

/** Remove the row at `idx` (0-based). */
export function removeRow(tbl: Element, idx: number): void {
  const rows = tableRows(tbl);
  if (idx < 0 || idx >= rows.length) return;
  tbl.removeChild(rows[idx]);
}

/** Set a body paragraph's full text (first run keeps formatting, rest blanked). */
export function setParaText(p: Element, text: string): void {
  const runs = childrenByName(p, "r");
  if (runs.length) {
    setRunText(runs[0], text);
    for (const r of runs.slice(1)) setRunTextBlank(r);
  } else {
    appendRunWithText(p, text);
  }
}
