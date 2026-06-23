import { bodyTables, loadDoc, serializeDoc } from "./docx-xml";
import { buildSections, getDocumentFlow, matchSectionsByPara, type SectionMatch } from "./sections";
import { distributeDataToTables, mergeSectionTables } from "./table-fill";
import { updateDynamicParagraphs } from "./paragraphs";

export interface MergeProgress {
  phase: string;
  detail?: string;
}

export interface MergeStats {
  templateTables: number;
  datasourceTables: number;
  templateSections: number;
  datasourceSections: number;
  matchedSections: number;
  filledTables: number;
  unmatchedWithTables: string[];
  updatedParagraphs: string[];
}

export type ProgressFn = (p: MergeProgress) => void;

const yieldToEventLoop = () => new Promise<void>((r) => setTimeout(r, 0));

/** Core merge: mutates tmplDoc in place. Runs Python main() steps 1-5. */
export async function mergeDocs(
  tmplDoc: Document,
  dsDoc: Document,
  onProgress: ProgressFn = () => {},
): Promise<MergeStats> {
  // Steps 1-2: parse flows + build sections.
  const tmplFlow = getDocumentFlow(tmplDoc);
  const dsFlow = getDocumentFlow(dsDoc);
  const tmplSections = buildSections(tmplFlow);
  const dsSections = buildSections(dsFlow);

  // Step 3: match sections.
  const matches: SectionMatch[] = matchSectionsByPara(tmplSections, dsSections);
  const matched = matches.filter((m) => m.datasource).length;
  const unmatchedWithTables = matches
    .filter((m) => !m.datasource && m.template.tables.length)
    .map((m) => (m.template.text ?? "N/A").slice(0, 60));
  onProgress({ phase: "Mencocokkan bagian", detail: `${matched}/${tmplSections.length} cocok` });
  await yieldToEventLoop();

  // Step 4: fill tables.
  let filledTables = 0;
  let sectionNo = 0;
  for (const m of matches) {
    sectionNo += 1;
    if (!m.datasource) {
      if (m.template.tables.length) onProgress({ phase: "Mengisi tabel", detail: `[SKIP] bagian ${sectionNo}` });
      continue;
    }
    const dsLogical = mergeSectionTables(dsDoc, m.datasource.tables);
    if (!dsLogical.length) continue;
    filledTables += distributeDataToTables(tmplDoc, m.template.tables, dsLogical);
    onProgress({ phase: "Mengisi tabel", detail: `[${filledTables} terisi] ${(m.template.text ?? "N/A").slice(0, 50)}` });
    if (sectionNo % 3 === 0) await yieldToEventLoop();
  }

  // Step 5: dynamic header paragraphs.
  const updatedParagraphs = updateDynamicParagraphs(tmplDoc, dsDoc);
  for (const u of updatedParagraphs) onProgress({ phase: "Menyalin paragraf header", detail: `Diperbarui: ${u}` });

  return {
    templateTables: 0,
    datasourceTables: 0,
    templateSections: tmplSections.length,
    datasourceSections: dsSections.length,
    matchedSections: matched,
    filledTables,
    unmatchedWithTables,
    updatedParagraphs,
  };
}

/** Full merge: load both .docx buffers, merge, serialize to bytes. */
export async function mergeLek(
  datasource: ArrayBuffer,
  template: ArrayBuffer,
  onProgress: ProgressFn = () => {},
): Promise<{ bytes: Uint8Array; stats: MergeStats }> {
  onProgress({ phase: "Memuat template baku" });
  await yieldToEventLoop();
  const tmplLoaded = loadDoc(template);

  onProgress({ phase: "Membaca datasource" });
  await yieldToEventLoop();
  const dsLoaded = loadDoc(datasource);

  const templateTables = bodyTables(tmplLoaded.doc).length;
  const datasourceTables = bodyTables(dsLoaded.doc).length;
  if (datasourceTables === 0) throw new Error("Datasource tidak berisi tabel.");
  onProgress({ phase: "Membaca datasource", detail: `${datasourceTables} tabel` });

  const stats = await mergeDocs(tmplLoaded.doc, dsLoaded.doc, onProgress);
  stats.templateTables = templateTables;
  stats.datasourceTables = datasourceTables;

  onProgress({ phase: "Menyusun output" });
  await yieldToEventLoop();
  const bytes = serializeDoc(tmplLoaded);
  onProgress({ phase: "Selesai" });
  return { bytes, stats };
}
