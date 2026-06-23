# Automasi LEK Docx — Design Spec

- **Date:** 2026-06-23
- **Status:** Approved (design); awaiting spec review → implementation plan
- **Owner:** fahri
- **Source feature:** `../docx/merge_lek_docx.py` (port target)
- **Commit policy:** Do **not** commit until explicitly requested by the user.

## 1. Goal

Add an **"Automasi LEK Docx"** tool under the **Evaluasi Kinerja BMN** menu in the `asguard-ext` Chrome extension. It is a faithful browser port of `../docx/merge_lek_docx.py`: a **docx-to-docx table migrator** that takes a raw, machine-generated LEK datasource (exported from SIMAN as a PDF-converted `.docx`) and migrates its table data into a polished template, producing one merged `_OUTPUT.docx`.

## 2. Context — what the Python script actually does

`merge_lek_docx.py` is **not** a mail-merge / placeholder substitution. It is a table migrator:

1. Walks each doc's `<w:body>` in document order → flat flow of `(paragraph_text, table_index)`.
2. Groups the flow into **sections** = the joined paragraph text preceding a contiguous run of tables + that table list.
3. **Matches** template sections ↔ datasource sections by word-overlap similarity (`|common_tokens| / max(|a|,|b|) × 100`, threshold `> 25`).
4. **Merges PDF-split table fragments**: consecutive datasource tables with identical header + column count whose first data row's "No" cell ≠ `"1"` are treated as continuations (rows appended).
5. **Fills** each template table: grows/shrinks it to exactly the datasource's data-row count (clones the last `<w:tr>`, clears `<w:t>` text, preserves header row 0), copying cell text.
6. **Distributes** data across template tables — three cases: 1:1 straight fill; 1 logical → many template tables (proportional split by each template table's original row count, last gets remainder); many:many (grouped by consecutive identical header+cols).
7. **Copies 5 dynamic header paragraphs** verbatim by prefix-match (`Nomor`, `Tanggal`, `No Paket Evaluasi`, `Kinerja Paket Evaluasi`, and the `Surat Tugas`/`Kepala` line), rewriting the first run and blanking the rest to preserve formatting.
8. Saves the mutated template as `<datasource_stem>_OUTPUT.docx`.

Dependencies: `python-docx` only. The `evaluasi_template.xlsx` in `../templates/` is **not** used by this script.

## 3. Decisions locked (from brainstorming)

| Decision | Choice |
|---|---|
| Data source | **Faithful 2-docx port** (not live SIMAN data) |
| Template | **Upload + persist (not bundled)** — user uploads the baku template `.docx` once; saved to `chrome.storage.local` (`asguard.lekTemplate`) and reused. Keeps `dist.crx` at ~967 KB |
| Compute location | **Panel-side, main thread** (DOMParser/XMLSerializer have no service-worker equivalent) |
| Output | **Download only** — `<datasource_stem>_OUTPUT.docx`, no upload back to SIMAN |
| SIMAN integration | **None** — the tool is decoupled from live SIMAN data; it is a pure docx transform living under the Evaluasi menu |
| Existing `eval/*` surface | **Untouched** |

## 4. Scope

**In scope**
- New `evaluasi-menu` choice screen with 2 options under Evaluasi Kinerja BMN.
- New `SimanEvaluasiLekView` (upload template + datasource → progress console → download).
- New `src/sidepanel/lek/` merge engine (faithful TS port).
- Template persistence: user-uploaded baku template saved to `chrome.storage.local` (single, replaceable).

**Out of scope**
- Any change to `eval/*` handlers, `siman-evaluasi` port, or the existing Evaluasi/Scorecard flow.
- Web Worker offloading (deferred — revisit only if main-thread jank is unacceptable in testing).
- Live SIMAN data integration, Excel input, or upload-back-to-SIMAN.

## 5. Architecture

### 5.1 Navigation (App.tsx)
- Add to `SimanView` union (`App.tsx:24`): `{ kind: "evaluasi-menu" }` and `{ kind: "evaluasi-lek" }`.
- Repoint `onGoEvaluasi` (`App.tsx:330`): `evaluasi` → `evaluasi-menu`.
- New `if (simanView.kind === "evaluasi-menu")` block (mirror `monitoring` block at `App.tsx:203-228`): two `menu-btn` choices using existing CSS (`styles.css:244`):
  - **"Automasi LEK Docx"** → `{ kind: "evaluasi-lek" }`
  - **"Evaluasi & Scorecard"** → `{ kind: "evaluasi" }` (existing flow, unchanged)
- `BackHeader` → SIMAN home.

### 5.2 View UX — `src/sidepanel/views/SimanEvaluasiLekView.tsx`
- `BackHeader` "Automasi LEK Docx" → back to `evaluasi-menu`.
- **Template zone**: if a saved baku template exists, show its name + "Ganti template"; otherwise a template upload picker (required once). On a fresh upload the template is saved to `chrome.storage.local` for reuse.
- **Datasource zone**: single upload (file picker + drag-drop), one `.docx`; shows filename + size when chosen.
- **"Mulai"** button (disabled until both a template — saved or just uploaded — and a datasource are present).
- Progress console reusing the dark monospace, color-coded styling from `AutomasiSection` (`SimanEvaluasiDetailView.tsx:67`), driven by **local async callbacks** (not a `chrome.runtime` port — panel-only).
  - Phase stream: *Memuat template baku… → Membaca datasource (N tabel, M baris)… → Mencocokkan bagian… → Mengisi tabel… → Menyalin paragraf header… → Menyusun output… → Selesai.*
- Success → **Download** button → `<datasource_stem>_OUTPUT.docx` via blob-anchor (`SimanRunView.tsx:48`).
- Error → red line + **Retry**; view stays interactive.

### 5.3 Template source & persistence (not bundled)
- No asset shipped. On first use the user uploads the baku template `.docx` alongside the datasource.
- Persisted to `chrome.storage.local` under `asguard.lekTemplate` (`{ base64, name, savedAt }`) via `src/sidepanel/lek/lek-template-store.ts` (panel-side; mirrors the existing Nadine/SIMAN template-store pattern). Subsequent runs reuse the saved template; "Ganti template" replaces it. Only the datasource is uploaded per run.
- Size: `dist.crx` unchanged (~967 KB). Saved template (~1.3 MB base64) lives in the user's `chrome.storage.local` (well under quota).

### 5.4 Merge engine — `src/sidepanel/lek/`
One responsibility per file (reviewable + diff-able vs. Python):

| File | Responsibility | Python counterpart |
|---|---|---|
| `lek-merge.ts` | Orchestrator `mergeLek({ datasource: ArrayBuffer, template: ArrayBuffer, onProgress }) → Promise<{ outputBase64: string; stats }>`; runs phases; emits progress. | `main()` |
| `docx-xml.ts` | Low-level OOXML ops on PizZip + DOMParser/XMLSerializer: `loadDocXml`, `getRowText`, `cloneRow`, `clearRowText`, `deleteRow`, `appendRow`, `getTableHeader`, `serialize`. | python-docx oxml ops |
| `sections.ts` | `getDocumentFlow`, `buildSections`, `matchSectionsByPara` (similarity > 25). | `get_document_flow`, `build_sections`, `match_sections_by_para`, `_text_sim` |
| `table-fill.ts` | `mergeSectionTables` (fragment de-dup via "No ≠ 1"), `distributeDataToTables` (1:1 / 1:many proportional / many:many), `fillTable` (resize rows). | `merge_section_tables`, `distribute_data_to_tables`, `fill_table`, `add_row_to_table`, `remove_row` |
| `paragraphs.ts` | `updateDynamicParagraphs` (5 header paragraphs, prefix-match, run-preserving rewrite). | `update_dynamic_paragraphs`, `_set_para` |
| `lek-template-store.ts` | Persist the user-uploaded baku template to `chrome.storage.local` (`asguard.lekTemplate`): `getLekTemplateMeta`, `getLekTemplateBytes`, `saveLekTemplate`, `clearLekTemplate`. | (new — mirrors `template-store.ts`) |

## 6. Algorithm faithfulness

Port `merge_lek_docx.py` 1:1, identical heuristics:
- Section matching: lowercased whitespace tokens, `|common| / max(|a|,|b|) × 100`, accept `> 25`.
- Fragment merge: consecutive datasource tables with identical header + column count where the first data row's "No" cell ≠ `"1"` ⇒ continuation (append rows); else new logical table.
- Table fill: grow/shrink to N data rows; clone last `<w:tr>` (clear `<w:t>`) to add; preserve header row 0; copy datasource cell text into template cells.
- Distribution: 1:1 straight fill; 1 logical → many template (proportional by original row counts, last table gets remainder); many:many (group by consecutive identical header+cols, match each group to the next logical table, proportional split within group).
- Header paragraphs: prefix-match `Nomor` / `Tanggal` / `No Paket Evaluasi` / `Kinerja Paket Evaluasi` / `Surat Tugas`+`Kepala`; rewrite first run's text, blank remaining runs (preserve formatting).
- Identifiers/comments kept close to the Python for diff-ability.
- Output filename: `<datasource filename stem>_OUTPUT.docx`.

## 7. Error handling
- Non-docx / bad zip (PizZip throws) → red "File bukan .docx valid."
- Datasource with 0 tables → "Datasource tidak berisi tabel."
- No saved template and none uploaded → "Unggah template baku terlebih dahulu."
- Unmatched template sections → **not an error** (Python leaves template tables as-is); logged "⚠ N bagian tidak cocok (dibiarkan apa adanya)".
- Any other throw → caught, message logged, view interactive for retry.
- Heavy ~19MB datasource parse → async phase-chunking (`await` yields between phases) keeps the console/spinner live.

## 8. Verification
The project has no test framework — `npm run typecheck` is the only static gate.
- `npm run typecheck` passes.
- **Faithfulness diff** (strongest signal): the repo ships a consistent 3-file oracle in `../docx/` — the baku template (`LEK - 1 DRAAFT.docx`), a sample datasource, and the known-good `..._OUTPUT.docx`. Run the port on the template + datasource and diff every output table cell against the known-good output. (`verify_output.txt` is **not** used — it was generated from a different datasource.) Fixture is read-only dev-time only — not shipped.
- Manual smoke: load unpacked → SIMAN tab → Evaluasi Kinerja BMN → Automasi LEK Docx → upload the baku template (saved for reuse) + the sample datasource → confirm a `_OUTPUT.docx` downloads and opens cleanly in Word.

## 9. Risks
- **Port size:** ~514 lines of algorithmic Python with genuinely gnarly parts (fragment merging, proportional distribution). The §8 faithfulness diff is the correctness gate.
- **Main-thread jank:** ~19MB `document.xml` parse + serialize on the main thread. Phase-chunking mitigates; if unacceptable, escalate to a Web Worker parse pass (deferred — out of scope here).
- **OOXML mutation fidelity:** python-docx vs. raw DOM differ in details (namespace handling, run/cell structure). `docx-xml.ts` must handle the real element shapes in the disk template/datasource, validated via the faithfulness diff.

## 10. File manifest (new)
- `src/sidepanel/lek/lek-merge.ts`
- `src/sidepanel/lek/docx-xml.ts`
- `src/sidepanel/lek/sections.ts`
- `src/sidepanel/lek/table-fill.ts`
- `src/sidepanel/lek/paragraphs.ts`
- `src/sidepanel/lek/lek-template-store.ts`
- `src/sidepanel/views/SimanEvaluasiLekView.tsx`

## 11. File manifest (modified)
- `src/sidepanel/App.tsx` — 2 new `SimanView` kinds, repoint `onGoEvaluasi`, new `evaluasi-menu` render block.
