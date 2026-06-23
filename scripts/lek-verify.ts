// Dev-only faithfulness harness. NOT shipped. Run: npx tsx scripts/lek-verify.ts
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import * as fs from "node:fs";
import * as path from "node:path";

(globalThis as { DOMParser?: typeof DOMParser }).DOMParser = DOMParser;
(globalThis as { XMLSerializer?: typeof XMLSerializer }).XMLSerializer = XMLSerializer;

import { bodyTables, cellText, loadDoc, rowCells, tableRows } from "../src/sidepanel/lek/docx-xml";
import { mergeDocs } from "../src/sidepanel/lek/lek-merge";

const DOCX_DIR = path.resolve(process.cwd(), "../docx");
const TEMPLATE = path.join(DOCX_DIR, "LEK - 1 DRAAFT.docx");
const DATASOURCE = path.join(DOCX_DIR, "Laporan Evaluasi Kinerja_LEK-2_PEK26030906590731841 (1).docx");
// Oracle = output of the CURRENT merge_lek_docx.py (v5), regenerated via
// `python3 scripts/lek-gen-oracle.py`. NOTE: ../docx/..._OUTPUT.docx is STALE
// (older script version) and must NOT be used as the diff target.
const EXPECTED = "/tmp/lek_v5_output.docx";

function load(p: string) {
  return loadDoc(new Uint8Array(fs.readFileSync(p)));
}

/** Dump every table's every row's every cell as a nested array of strings. */
function dumpCells(doc: Document): string[][][] {
  return bodyTables(doc).map((tbl) =>
    tableRows(tbl).map((tr) => rowCells(tr).map((tc) => cellText(tc))),
  );
}

async function main() {
  for (const [label, p] of [["template", TEMPLATE], ["datasource", DATASOURCE], ["expected", EXPECTED]] as const) {
    if (!fs.existsSync(p)) {
      console.error(`MISSING fixture: ${p}`);
      process.exit(1);
    }
    const { doc } = load(p);
    const tables = bodyTables(doc);
    console.log(`${label}: ${tables.length} tables, ${tables.reduce((s, t) => s + tableRows(t).length, 0)} rows`);
  }

  // Run the real merge on (template, datasource). mergeDocs mutates `tmpl` in place.
  const tmpl = load(TEMPLATE).doc;
  const ds = load(DATASOURCE).doc;
  const stats = await mergeDocs(tmpl, ds);
  console.log(
    `merge: ${stats.templateSections}/ds${stats.datasourceSections} sections, matched=${stats.matchedSections}, filled=${stats.filledTables}, paras=${stats.updatedParagraphs.length}`,
  );

  // Faithfulness diff: merged template cells vs known-good output cells.
  const got = dumpCells(tmpl);
  const want = dumpCells(load(EXPECTED).doc);
  let mismatches = 0;
  const n = Math.max(got.length, want.length);
  for (let t = 0; t < n; t++) {
    const gt = got[t] ?? [];
    const wt = want[t] ?? [];
    const rows = Math.max(gt.length, wt.length);
    for (let r = 0; r < rows; r++) {
      const gr = gt[r] ?? [];
      const wr = wt[r] ?? [];
      const cols = Math.max(gr.length, wr.length);
      for (let c = 0; c < cols; c++) {
        const g = gr[c] ?? "";
        const w = wr[c] ?? "";
        if (g !== w) {
          mismatches++;
          if (mismatches <= 25) console.log(`  DIFF T${t} R${r} C${c}: got=${JSON.stringify(g)} want=${JSON.stringify(w)}`);
        }
      }
    }
  }
  console.log(mismatches === 0 ? "PASS: 0 cell mismatch (faithful to known-good output)" : `FAIL: ${mismatches} cell mismatches`);
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
