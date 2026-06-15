import { useEffect, useRef, useState } from "preact/hooks";
import type { NaskahTemplate, MailMergeProgressMsg, MailMergeRowMsg, MailMergeExcel, OrgUnit } from "@/shared/types";
import { parseExcel, getSheetNames, type ParsedExcel } from "../mailmerge/excel-parser";
import { scanPlaceholders } from "../mailmerge/placeholder-scan";
import { renderDocx, uint8ToBase64 } from "../mailmerge/docx-render";

interface Props {
  templateId: string;
  onBack: () => void;
}

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function getPerihal(payload: Record<string, unknown>): string {
  const d = payload.Perihal as string | undefined;
  if (d?.trim()) return d.trim();
  const dn = payload.DataNd as Record<string, unknown> | undefined;
  return (dn?.Perihal as string | undefined)?.trim() || "—";
}

function mergePlaceholders(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

function rowPreview(row: Record<string, string>, headers: string[], cols: string[]): string {
  const c = cols.length > 0 ? cols : (() => {
    const p = headers.find((h) => h.toLowerCase() === "perihal");
    return [...(p ? [p] : []), ...headers.filter((h) => h !== p).slice(0, 2)].slice(0, 3);
  })();
  return c.map((h) => row[h]).filter(Boolean).join(" · ");
}

function parsedToStored(p: ParsedExcel, filename: string): MailMergeExcel {
  return { filename, sheetName: p.sheetName, headers: p.headers, rows: p.rows };
}

function storedToDisplay(s: MailMergeExcel): ParsedExcel {
  return { headers: s.headers, rows: s.rows, sheetName: s.sheetName, rowCount: s.rows.length };
}

type Step = "setup" | "mapping" | "select" | "running" | "done";

interface RowResult {
  portIndex: number;
  origIndex: number;
  ndId?: number;
  error?: string;
  steps: string[];
}

type ExpandedRow = {
  portIndex: number;
  origIndex: number;
  data: Record<string, string>;
  perihal: string;
};

export function MailMergeView({ templateId, onBack }: Props) {
  const [template, setTemplate] = useState<NaskahTemplate | null>(null);
  const [step, setStep] = useState<Step>("setup");

  const [ndPlaceholders, setNdPlaceholders] = useState<string[]>([]);
  const [npPlaceholders, setNpPlaceholders] = useState<string[]>([]);
  const placeholders = mergePlaceholders(ndPlaceholders, npPlaceholders);

  // Setup
  const [excel, setExcel] = useState<ParsedExcel | null>(null);
  const [savedFilename, setSavedFilename] = useState("");
  const [fileError, setFileError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Sheet picker state
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [showSheetPicker, setShowSheetPicker] = useState(false);
  const [selectedSheet, setSelectedSheet] = useState("");

  // Mapping — regular ph→col, plus perihal override
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [perihalColMap, setPerihalColMap] = useState(""); // col that overrides Perihal field
  const [mappingSaved, setMappingSaved] = useState(false);
  const [savingMapping, setSavingMapping] = useState(false);

  // Row selection
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [previewCols, setPreviewCols] = useState<string[]>([]);

  // NP penandatangan picker (shown before run if not yet saved on template)
  const [showNpPicker, setShowNpPicker] = useState(false);
  const [npUnits, setNpUnits] = useState<OrgUnit[] | null>(null);
  const [npUnitsLoading, setNpUnitsLoading] = useState(false);
  const [chosenNpUnit, setChosenNpUnit] = useState<OrgUnit | null>(null);

  // Run
  const [results, setResults] = useState<RowResult[]>([]);
  const [currentRow, setCurrentRow] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [activeSteps, setActiveSteps] = useState<string[]>([]);
  const [aborted, setAborted] = useState(false);
  const [summary, setSummary] = useState<{ success: number; failed: number; ndIds: number[] } | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const abortedRef = useRef(false);

  // Determine if penandatangan NP picker is needed (same logic as RunModal)
  const pengirimParam = template?.payload.PengirimNdParam as Record<string, unknown> | undefined;
  const pengirimData = (pengirimParam?.Pengirim ?? {}) as Record<string, unknown>;
  const eselon = pengirimData.Eselon as number | undefined;
  const needsNpPicker = eselon !== undefined && eselon <= 3 && !template?.notaPengantarData?.Penandatangan;

  async function fetchNpUnits() {
    setNpUnitsLoading(true);
    const kodeOrg = (pengirimData.KodeOrganisasi ?? pengirimData.KodeUnit ?? "") as string;
    const res = await send<{ ok: boolean; data?: OrgUnit[] }>({
      type: "template/units",
      kodeOrganisasi: kodeOrg,
      pengirimEselon: eselon as number,
    });
    setNpUnits(res.ok ? (res.data ?? []) : []);
    setNpUnitsLoading(false);
  }

  useEffect(() => {
    send<{ ok: boolean; data: NaskahTemplate }>({ type: "template/get", id: templateId }).then((r) => {
      if (!r.ok) return;
      const t = r.data;
      setTemplate(t);

      if (t.konsepFile) setNdPlaceholders(scanPlaceholders(t.konsepFile.base64));
      if (t.konsepNotaFile) setNpPlaceholders(scanPlaceholders(t.konsepNotaFile.base64));

      if (t.mailMergeExcel && t.mailMergeExcel.rows.length > 0) {
        setExcel(storedToDisplay(t.mailMergeExcel));
        setSavedFilename(t.mailMergeExcel.filename);

        const saved = t.mailMergeMapping ?? {};
        setPerihalColMap(saved["__perihal__"] ?? "");

        // If mapping was previously saved → skip straight to row selection
        if (t.mailMergeMapping !== undefined) {
          setStep("select");
        } else {
          setStep("mapping");
        }
      }
    });
  }, [templateId]);

  // Build ph→col mapping from saved state + auto-match
  useEffect(() => {
    if (!excel) return;
    const saved = template?.mailMergeMapping ?? {};
    const auto: Record<string, string> = {};
    for (const ph of placeholders) {
      if (saved[ph] && excel.headers.includes(saved[ph])) {
        auto[ph] = saved[ph];
        continue;
      }
      const match = excel.headers.find((h) => h.toLowerCase() === ph.toLowerCase());
      auto[ph] = match ?? excel.headers[0] ?? "";
    }
    setMapping(auto);
  }, [excel, placeholders.join(","), template?.mailMergeMapping]);

  // Default preview columns
  useEffect(() => {
    if (!excel) return;
    const p = excel.headers.find((h) => h.toLowerCase() === "perihal");
    setPreviewCols([...(p ? [p] : []), ...excel.headers.filter((h) => h !== p).slice(0, 2)].slice(0, 3));
  }, [excel]);

  async function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setFileError("");
    try {
      const names = await getSheetNames(file);
      if (names.length === 0) {
        setFileError("File tidak memiliki sheet.");
        return;
      }
      if (names.length === 1) {
        // Single sheet — parse immediately (legacy behavior)
        await parseAndSetExcel(file, names[0]);
      } else {
        // Multiple sheets — show picker
        setPendingFile(file);
        setSheetNames(names);
        setSelectedSheet(names[0]);
        setShowSheetPicker(true);
      }
    } catch (err) {
      setFileError(`Gagal membaca file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function parseAndSetExcel(file: File, sheetName: string) {
    try {
      const parsed = await parseExcel(file, sheetName);
      if (parsed.rowCount === 0) { setFileError(`Sheet "${sheetName}" tidak memiliki data.`); return; }
      setExcel(parsed);
      setSavedFilename(file.name);
      setStep("mapping");
    } catch (err) {
      setFileError(`Gagal membaca sheet: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleSheetConfirm() {
    if (!pendingFile || !selectedSheet) return;
    setShowSheetPicker(false);
    await parseAndSetExcel(pendingFile, selectedSheet);
    setPendingFile(null);
    setSheetNames([]);
  }

  function handleSheetCancel() {
    setShowSheetPicker(false);
    setPendingFile(null);
    setSheetNames([]);
    setSelectedSheet("");
  }

  async function saveMapping() {
    if (!template || !excel) return;
    setSavingMapping(true);
    // Only persist keys that are currently visible in the UI (avoids stale keys from old docx versions)
    const cleanMapping: Record<string, string> = {};
    for (const ph of placeholders) cleanMapping[ph] = mapping[ph] ?? "";
    await send({
      type: "template/update",
      id: template.id,
      updates: {
        mailMergeMapping: { ...cleanMapping, __perihal__: perihalColMap },
        mailMergeExcel: parsedToStored(excel, savedFilename),
      },
    });
    setSavingMapping(false);
    setMappingSaved(true);
    setTimeout(() => setMappingSaved(false), 2500);
  }

  function goToSelect() {
    setSelectedRows(new Set());
    setSearchQuery("");
    setStep("select");
  }

  function toggleRow(idx: number) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }

  function togglePreviewCol(col: string) {
    setPreviewCols((prev) => prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]);
  }

  function doSelectAll(filtered: number[]) {
    setSelectedRows((prev) => { const n = new Set(prev); filtered.forEach((i) => n.add(i)); return n; });
  }
  function doSelectNone(filtered: number[]) {
    setSelectedRows((prev) => { const n = new Set(prev); filtered.forEach((i) => n.delete(i)); return n; });
  }

  function handleAbort() {
    abortedRef.current = true;
    setAborted(true);
    portRef.current?.postMessage({ type: "mm/abort" } satisfies MailMergeRowMsg);
  }

  function buildRows(rowIndices: number[]): ExpandedRow[] {
    if (!excel) return [];
    return rowIndices.map((rowIdx, portIndex) => {
      const row = excel.rows[rowIdx];
      const data: Record<string, string> = {};
      for (const [ph, col] of Object.entries(mapping)) {
        data[ph] = row[col] ?? ""; // pass raw; renderDocx handles ";" → row/list/linebreak
      }
      const perihal = perihalColMap ? (row[perihalColMap] ?? "").trim() : "";
      return { portIndex, origIndex: rowIdx, data, perihal };
    });
  }

  function handleRunClick() {
    if (needsNpPicker) {
      setShowNpPicker(true);
      if (!npUnits) fetchNpUnits();
    } else {
      startRun(null);
    }
  }

  async function startRun(penandatanganUnit: OrgUnit | null) {
    if (!template || !excel || !template.konsepFile) return;
    setShowNpPicker(false);
    const rowIndices = [...selectedRows].sort((a, b) => a - b);
    if (rowIndices.length === 0) return;

    const expandedRows = buildRows(rowIndices);
    if (expandedRows.length === 0) return;

    setStep("running");
    setResults([]);
    setCurrentRow(0);
    setTotalRows(expandedRows.length);
    setActiveSteps([]);
    setAborted(false);
    abortedRef.current = false;
    setSummary(null);

    const port = chrome.runtime.connect({ name: "mail-merge-run" });
    portRef.current = port;

    // Local step log before port is ready (render errors)
    const rowSteps: Map<number, string[]> = new Map();
    const addStep = (portIndex: number, s: string) => {
      const steps = rowSteps.get(portIndex) ?? [];
      steps.push(s);
      rowSteps.set(portIndex, steps);
    };
    let currentPortIdx = 0;

    port.onMessage.addListener((msg: MailMergeProgressMsg) => {
      if (msg.type === "mm/row-step") {
        const steps = rowSteps.get(msg.index) ?? [];
        steps.push(msg.step);
        rowSteps.set(msg.index, steps);
        if (msg.index === currentPortIdx) setActiveSteps([...steps]);
      } else if (msg.type === "mm/row-done") {
        const steps = rowSteps.get(msg.index) ?? []; // includes pre-render steps + background steps
        const er = expandedRows[msg.index];
        setResults((prev) => [...prev, {
          portIndex: msg.index,
          origIndex: er?.origIndex ?? msg.index,
          ndId: msg.ndId, error: msg.error, steps,
        }]);
        setActiveSteps([]);
        setCurrentRow((c) => c + 1);
        currentPortIdx = msg.index + 1;
      } else if (msg.type === "mm/complete") {
        setSummary({ success: msg.success, failed: msg.failed, ndIds: msg.ndIds });
        setStep("done");
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(() => {
      setStep((s) => (s === "running" ? "done" : s));
    });

    port.postMessage({
      type: "mm/start", templateId: template.id, total: expandedRows.length,
      ...(penandatanganUnit ? { penandatanganUnit: penandatanganUnit as Record<string, unknown> } : {}),
    } satisfies MailMergeRowMsg);

    const konsepBase64 = template.konsepFile.base64;
    const konsepName = template.konsepFile.name;
    const npBase64 = template.konsepNotaFile?.base64;
    const npName = template.konsepNotaFile?.name;
    const hasNpPh = npPlaceholders.length > 0;

    for (const er of expandedRows) {
      if (abortedRef.current) break;

      const payload = { ...template.payload };
      if (er.perihal) payload.Perihal = er.perihal;

      let docxBase64 = konsepBase64;
      try {
        docxBase64 = uint8ToBase64(renderDocx(konsepBase64, er.data));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[asguard] row ${er.origIndex} ND render failed:`, e);
        addStep(er.portIndex, `⚠️ Render ND gagal: ${msg.slice(0, 80)}`);
      }

      const filename = konsepName.replace(/\.docx?$/i, `_row${er.origIndex + 1}.docx`);

      let npDocxBase64: string | undefined;
      let npFilename: string | undefined;
      if (npBase64 && npName) {
        npDocxBase64 = npBase64;
        if (hasNpPh) {
          try { npDocxBase64 = uint8ToBase64(renderDocx(npBase64, er.data)); }
          catch (e) {
            console.error(`[asguard] row ${er.origIndex} NP render failed:`, e);
            addStep(er.portIndex, `⚠️ Render NP gagal: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`);
          }
        }
        npFilename = npName.replace(/\.docx?$/i, `_row${er.origIndex + 1}.docx`);
      }

      port.postMessage({
        type: "mm/row", index: er.portIndex, payload, docxBase64, filename,
        ...(npDocxBase64 ? { npDocxBase64, npFilename } : {}),
      } satisfies MailMergeRowMsg);

      await waitForRowDone(port, er.portIndex);
    }
  }

  // ─────────────────── Views ───────────────────

  if (!template) return <div class="view-template fade-in"><p class="hint">Memuat template…</p></div>;

  if (!template.konsepFile) {
    return (
      <div class="view-template fade-in">
        <button class="btn btn--ghost btn--sm back-btn" onClick={onBack}>← Kembali</button>
        <div class="mm-notice">
          <p>Template ini tidak memiliki file konsep (.docx).</p>
          <p class="hint">Upload file konsep di Detail Template terlebih dahulu.</p>
        </div>
      </div>
    );
  }

  // ── Setup ──────────────────────────────────────────────
  if (step === "setup") {
    return (
      <div class="view-template fade-in">
        <button class="btn btn--ghost btn--sm back-btn" onClick={onBack}>← Kembali</button>
        <h2 class="section-title">Mail Merge</h2>

        <div class="mm-info-card">
          <div class="mm-info-row"><span class="mm-info-label">Template</span><span>{template.name}</span></div>
          <div class="mm-info-row"><span class="mm-info-label">Perihal</span><span class="mm-info-value--muted">{getPerihal(template.payload)}</span></div>
          <div class="mm-info-row"><span class="mm-info-label">File ND</span><span>📄 {template.konsepFile.name}</span></div>
          {template.konsepNotaFile && (
            <div class="mm-info-row"><span class="mm-info-label">File NP</span><span>📄 {template.konsepNotaFile.name}</span></div>
          )}
          {placeholders.length > 0 ? (
            <div class="mm-info-row mm-info-row--placeholders">
              <span class="mm-info-label">Placeholder</span>
              <span class="mm-placeholders">
                {ndPlaceholders.map((p) => <code key={`nd-${p}`} class="mm-ph" title="Nota Dinas">{`{${p}}`}</code>)}
                {npPlaceholders.filter((p) => !ndPlaceholders.includes(p)).map((p) => (
                  <code key={`np-${p}`} class="mm-ph mm-ph--np" title="Nota Pengantar">{`{${p}}`}</code>
                ))}
              </span>
            </div>
          ) : (
            <div class="mm-info-row"><span class="mm-info-label">Placeholder</span><span class="mm-info-value--muted">Tidak ditemukan</span></div>
          )}
          {template.mailMergeMapping !== undefined && (
            <div class="mm-info-row"><span class="mm-info-label">Pemetaan</span><span class="mm-saved-badge">✓ Tersimpan</span></div>
          )}
        </div>

        <div class="field">
          <span class="field__label">Upload Data Excel (.xlsx)</span>
          <button class="btn btn--ghost" onClick={() => fileRef.current?.click()}>📊 Pilih file Excel…</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style="display:none" onChange={handleFileChange} />
          {fileError && <p class="error-text">{fileError}</p>}
        </div>

        <p class="hint">Baris pertama = nama kolom. Cocokkan dengan <code>{`{placeholder}`}</code> di file konsep.</p>

        {/* Sheet picker modal */}
        {showSheetPicker && (
          <div class="modal-overlay">
            <div class="modal">
              <h2 class="modal__title">📊 Pilih Sheet</h2>
              <p class="modal__sub">File memiliki {sheetNames.length} sheet. Pilih sheet yang akan digunakan:</p>

              <div class="mm-sheet-picker">
                {sheetNames.map((name, i) => (
                  <button
                    key={i}
                    class={`mm-sheet-item ${selectedSheet === name ? "mm-sheet-item--active" : ""}`}
                    onClick={() => setSelectedSheet(name)}
                  >
                    <span class="mm-sheet-item__icon">{selectedSheet === name ? "●" : "○"}</span>
                    <span class="mm-sheet-item__name">{name}</span>
                  </button>
                ))}
              </div>

              <div class="modal__actions">
                <button class="btn btn--ghost" onClick={handleSheetCancel}>Batal</button>
                <button class="btn btn--primary" onClick={handleSheetConfirm} disabled={!selectedSheet}>Gunakan Sheet Ini</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Mapping ────────────────────────────────────────────
  if (step === "mapping" && excel) {
    const unmatched = placeholders.filter((ph) => !mapping[ph] || !excel.headers.includes(mapping[ph]));

    return (
      <div class="view-template fade-in">
        <button class="btn btn--ghost btn--sm back-btn" onClick={() => {
          if (template.mailMergeExcel) setStep("select"); else { setStep("setup"); setExcel(null); }
        }}>← Kembali</button>
        <h2 class="section-title">Pemetaan Kolom</h2>

        <div class="mm-stats">
          {savedFilename && <><span>📊 {savedFilename}</span><span>·</span></>}
          <span>📋 {excel.sheetName}</span><span>·</span>
          <span>{excel.rowCount} baris</span><span>·</span>
          <span>{excel.headers.length} kolom</span>
          <button class="btn btn--ghost btn--xs mm-change-file" onClick={() => fileRef.current?.click()}>Ganti file</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style="display:none" onChange={handleFileChange} />
        </div>

        {/* Placeholder → column mapping */}
        {placeholders.length > 0 ? (
          <div class="mm-table">
            <div class="mm-table__head"><span>Placeholder</span><span>Kolom Excel</span><span></span></div>
            {placeholders.map((ph) => {
              const col = mapping[ph] ?? "";
              const matched = excel.headers.includes(col) && col !== "";
              const isNp = npPlaceholders.includes(ph) && !ndPlaceholders.includes(ph);
              return (
                <div key={ph} class="mm-table__row">
                  <code class={`mm-ph ${isNp ? "mm-ph--np" : ""}`} title={isNp ? "Nota Pengantar" : "Nota Dinas"}>{`{${ph}}`}</code>
                  <select class="mm-select" value={col} onChange={(e) => {
                    setMapping({ ...mapping, [ph]: (e.target as HTMLSelectElement).value });
                    setMappingSaved(false);
                  }}>
                    <option value="">— pilih —</option>
                    {excel.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <span class={`mm-status ${matched ? "mm-status--ok" : "mm-status--warn"}`}>{matched ? "✓" : "!"}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p class="hint">Tidak ada placeholder — dokumen akan di-upload apa adanya.</p>
        )}

        {/* Special options */}
        <div class="mm-special-section">
          <p class="mm-special-title">Opsi Lanjutan</p>

          <div class="mm-table__row mm-table__row--special">
            <span class="mm-special-label">Perihal (dinamis)</span>
            <select class="mm-select" value={perihalColMap} onChange={(e) => {
              setPerihalColMap((e.target as HTMLSelectElement).value); setMappingSaved(false);
            }}>
              <option value="">— tetap bawaan —</option>
              {excel.headers.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
            <span class="mm-status mm-status--info" title="Override perihal dari kolom Excel">P</span>
          </div>

          <p class="hint" style="margin:0">Isi sel dengan nilai dipisah <code>;</code> untuk membuat baris baru di dalam dokumen.</p>
        </div>

        {/* Preview */}
        {excel.rows.length > 0 && (
          <div class="mm-preview">
            <p class="mm-preview__label">Preview baris pertama</p>
            {excel.headers.map((h) => (
              <div key={h} class="mm-preview__row">
                <span class="mm-preview__col">{h}</span>
                <span class="mm-preview__val">{excel.rows[0][h] || <em>kosong</em>}</span>
              </div>
            ))}
          </div>
        )}

        {unmatched.length > 0 && (
          <p class="hint" style="color: #d97706">⚠️ {unmatched.length} placeholder belum dipetakan</p>
        )}

        <div class="mm-mapping-actions">
          <button class="btn btn--ghost btn--sm" onClick={saveMapping} disabled={savingMapping || mappingSaved}>
            {savingMapping ? "Menyimpan…" : mappingSaved ? "✓ Tersimpan" : "Simpan Pemetaan"}
          </button>
          <button class="btn btn--primary" onClick={goToSelect}>Pilih Baris →</button>
        </div>
      </div>
    );
  }

  // ── Row Selection ──────────────────────────────────────
  if (step === "select" && excel) {
    const q = searchQuery.trim().toLowerCase();
    const filteredIndices = excel.rows.reduce<number[]>((acc, row, i) => {
      if (!q || excel.headers.some((h) => (row[h] ?? "").toLowerCase().includes(q))) acc.push(i);
      return acc;
    }, []);
    const filteredSelected = filteredIndices.filter((i) => selectedRows.has(i));
    const allFilteredSelected = filteredIndices.length > 0 && filteredSelected.length === filteredIndices.length;

    return (
      <div class="view-template fade-in">
        <button class="btn btn--ghost btn--sm back-btn" onClick={onBack}>← Kembali</button>
        <h2 class="section-title">Pilih Baris</h2>

        <div class="mm-select-bar">
          <button class="btn btn--ghost btn--sm" onClick={() => allFilteredSelected ? doSelectNone(filteredIndices) : doSelectAll(filteredIndices)}>
            {allFilteredSelected ? "✗ Batalkan" : "✓ Pilih Semua"}{q ? " hasil filter" : ""}
          </button>
          <span class="mm-select-bar__counter">{selectedRows.size} / {excel.rowCount} dipilih</span>
          <button class="btn btn--ghost btn--xs" onClick={() => setStep("mapping")} title="Ubah pemetaan atau file Excel">
            ✎ Konfigurasi
          </button>
        </div>

        <input class="mm-search" type="text" placeholder="Cari baris…"
          value={searchQuery} onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)} />


        {excel.headers.length > 0 && (
          <div class="mm-col-picker">
            <span class="mm-col-picker__label">Tampilkan:</span>
            {excel.headers.map((h) => (
              <button key={h} class={`mm-col-chip ${previewCols.includes(h) ? "mm-col-chip--active" : ""}`}
                onClick={() => togglePreviewCol(h)}>{h}</button>
            ))}
          </div>
        )}

        <div class="mm-row-select">
          {filteredIndices.length === 0 && <p class="hint" style="padding: var(--sp-2)">Tidak ada baris yang cocok.</p>}
          {filteredIndices.map((i) => {
            const row = excel.rows[i];
            const checked = selectedRows.has(i);
            const preview = rowPreview(row, excel.headers, previewCols);
            return (
              <label key={i} class={`mm-row-item ${checked ? "mm-row-item--checked" : ""}`}>
                <input type="checkbox" class="mm-row-item__cb" checked={checked} onChange={() => toggleRow(i)} />
                <span class="mm-row-item__num">Baris {i + 1}</span>
                {preview && <span class="mm-row-item__preview">{preview}</span>}
              </label>
            );
          })}
        </div>

        <div class="mm-run-footer">
          <button class="btn btn--primary" onClick={handleRunClick} disabled={selectedRows.size === 0}>
            ▶ Jalankan {selectedRows.size} Baris
          </button>
        </div>

        {/* NP penandatangan picker modal */}
        {showNpPicker && (
          <div class="modal-overlay">
            <div class="modal">
              <h2 class="modal__title">📝 Pilih Penandatangan NP</h2>
              <p class="modal__sub">Eselon {eselon} → pilih pejabat eselon {(eselon ?? 0) + 1} di bawahnya</p>

              {npUnitsLoading && <p class="modal__hint">Memuat daftar unit…</p>}

              {npUnits && npUnits.length === 0 && (
                <p class="modal__hint" style="color: var(--color-warning)">Tidak ada unit ditemukan.</p>
              )}

              {npUnits && npUnits.length > 0 && (
                <div class="unit-picker">
                  {npUnits.map((u, i) => (
                    <button key={i}
                      class={`unit-picker__item ${chosenNpUnit === u ? "unit-picker__item--active" : ""}`}
                      onClick={() => setChosenNpUnit(u)}>
                      <span class="unit-picker__jabatan">{u.NamaJabatan || "—"}</span>
                      <span class="unit-picker__meta">{u.NamaPejabat || "—"} · Es.{u.Eselon}</span>
                    </button>
                  ))}
                </div>
              )}

              <div class="modal__actions">
                <button class="btn btn--ghost" onClick={() => setShowNpPicker(false)}>Batal</button>
                <button class="btn btn--primary"
                  disabled={!!npUnits && npUnits.length > 0 && !chosenNpUnit}
                  onClick={() => startRun(chosenNpUnit)}>
                  Jalankan
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Running / Done ─────────────────────────────────────
  if (step === "running" || step === "done") {
    return (
      <div class="view-template fade-in">
        {step === "done" && <button class="btn btn--ghost btn--sm back-btn" onClick={onBack}>← Kembali</button>}
        <h2 class="section-title">
          {step === "running"
            ? `⏳ Menjalankan… (${currentRow}/${totalRows})`
            : summary?.failed ? "⚠️ Selesai" : "✅ Selesai"}
        </h2>

        {summary && (
          <div class="mm-summary">
            <span class="mm-summary__ok">✓ {summary.success} berhasil</span>
            {summary.failed > 0 && <span class="mm-summary__err">✗ {summary.failed} gagal</span>}
          </div>
        )}

        <div class="mm-progress">
          {results.map((r) => (
            <div key={r.portIndex} class={`mm-progress__row ${r.error ? "mm-progress__row--err" : "mm-progress__row--ok"}`}>
              <div class="mm-progress__header">
                <span class="mm-progress__icon">{r.error ? "✗" : "✓"}</span>
                <span class="mm-progress__label">
                  Baris {r.origIndex + 1}
                </span>
                {r.ndId && <span class="mm-progress__ndid">ND #{r.ndId}</span>}
                {r.error && <span class="mm-progress__error">{r.error}</span>}
              </div>
              {r.steps.length > 0 && (
                <div class="mm-progress__steps">
                  {r.steps.map((s, si) => <div key={si} class="mm-progress__step">{s}</div>)}
                </div>
              )}
            </div>
          ))}

          {step === "running" && currentRow < totalRows && (
            <div class="mm-progress__row mm-progress__row--active">
              <div class="mm-progress__header">
                <span class="mm-progress__icon">⏳</span>
                <span class="mm-progress__label">Memproses dokumen {currentRow + 1}…</span>
              </div>
              {activeSteps.length > 0 && (
                <div class="mm-progress__steps">
                  {activeSteps.map((s, si) => <div key={si} class={`mm-progress__step ${si === activeSteps.length - 1 ? "mm-progress__step--active" : ""}`}>{s}</div>)}
                </div>
              )}
            </div>
          )}
        </div>

        {step === "running" && !aborted && (
          <button class="btn btn--ghost btn--sm" style="color: var(--error)" onClick={handleAbort}>Batalkan</button>
        )}
        {aborted && step === "running" && (
          <p class="hint" style="color: var(--error)">Membatalkan setelah dokumen ini selesai…</p>
        )}
      </div>
    );
  }

  return null;
}

function waitForRowDone(port: chrome.runtime.Port, index: number): Promise<void> {
  return new Promise((resolve) => {
    const handler = (msg: MailMergeProgressMsg) => {
      if (msg.type === "mm/row-done" && msg.index === index) {
        port.onMessage.removeListener(handler);
        resolve();
      }
    };
    port.onMessage.addListener(handler);
  });
}
