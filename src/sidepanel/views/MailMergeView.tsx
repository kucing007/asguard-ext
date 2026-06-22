import { useEffect, useRef, useState } from "preact/hooks";
import type { NaskahTemplate, MailMergeProgressMsg, MailMergeRowMsg, MailMergeExcel, OrgUnit } from "@/shared/types";
import { Icon } from "../components/Icon";
import { parseExcel, getSheetNames, type ParsedExcel } from "../mailmerge/excel-parser";
import { scanPlaceholders } from "../mailmerge/placeholder-scan";
import { renderDocx, uint8ToBase64 } from "../mailmerge/docx-render";
import { saveHandle, loadHandle, clearHandle, canRead } from "../mailmerge/file-handle";
import { useModalEscape } from "../components/useModalEscape";

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

const MM_STEPS = ["Setup", "Pemetaan", "Pilih Baris", "Jalankan"] as const;

function mmStepIndex(step: Step): number {
  if (step === "setup") return 0;
  if (step === "mapping") return 1;
  if (step === "select") return 2;
  if (step === "running") return 3;
  return 4; // done
}

function StepIndicator({ step }: { step: Step }) {
  const idx = mmStepIndex(step);
  return (
    <div class="mm-steps" aria-label="Langkah mail merge">
      {MM_STEPS.map((label, i) => (
        <div key={label} class={`mm-steps__item${i < idx ? " mm-steps__item--done" : ""}${i === idx ? " mm-steps__item--active" : ""}`}>
          <span class="mm-steps__dot">{i < idx ? <Icon name="check" size={12} /> : i + 1}</span>
          <span class="mm-steps__label">{label}</span>
        </div>
      ))}
    </div>
  );
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div class="mm-progressbar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progress batch">
      <div class="mm-progressbar__fill" style={`width:${pct}%`} />
    </div>
  );
}

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
  const [fileHandle, setFileHandle] = useState<FileSystemFileHandle | null>(null);

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
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);
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
  const [showRunConfirm, setShowRunConfirm] = useState(false);
  useModalEscape(showRunConfirm, () => setShowRunConfirm(false));
  useModalEscape(showSheetPicker, handleSheetCancel);
  useModalEscape(showNpPicker, () => setShowNpPicker(false));
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

  // Load the persisted file handle (if any) so "Muat Ulang" can re-read silently.
  useEffect(() => {
    loadHandle(templateId).then((h) => { if (h) setFileHandle(h); }).catch(() => {});
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

  async function ingestFile(file: File) {
    setFileError("");
    try {
      const names = await getSheetNames(file);
      if (names.length === 0) { setFileError("File tidak memiliki sheet."); return; }
      if (names.length === 1) {
        await parseAndSetExcel(file, names[0]);
      } else {
        setPendingFile(file);
        setSheetNames(names);
        setSelectedSheet(names[0]);
        setShowSheetPicker(true);
      }
    } catch (err) {
      setFileError(`Gagal membaca file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) await ingestFile(file);
    input.value = ""; // allow re-selecting the same file later
  }

  async function parseAndSetExcel(file: File, sheetName: string) {
    try {
      const parsed = await parseExcel(file, sheetName);
      if (parsed.rowCount === 0) { setFileError(`Sheet "${sheetName}" tidak memiliki data.`); return; }
      setExcel(parsed);
      setSavedFilename(file.name);
      // Auto-save the new Excel data so rows are always up to date
      if (template) {
        await send({
          type: "template/update",
          id: template.id,
          updates: { mailMergeExcel: parsedToStored(parsed, file.name) },
        });
      }
      setStep(template?.mailMergeMapping ? "select" : "mapping");
    } catch (err) {
      setFileError(`Gagal membaca sheet: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  type OpenFn = (opts: {
    multiple?: boolean;
    types?: Array<{ description?: string; accept?: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle[]>;

  /** Pick an Excel file. Prefers the File System Access API (so later "Muat Ulang"
   *  can re-read silently); falls back to the hidden <input>. */
  async function pickFile() {
    if (!template) return;
    const showOpen = (window as unknown as { showOpenFilePicker?: OpenFn }).showOpenFilePicker;
    if (typeof showOpen === "function") {
      try {
        const [handle] = await showOpen({
          multiple: false,
          types: [{
            description: "Excel",
            accept: {
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
              "application/vnd.ms-excel": [".xls"],
            },
          }],
        });
        const file = await handle.getFile();
        setFileHandle(handle);
        await saveHandle(template.id, handle);
        await ingestFile(file);
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return; // user cancelled
        // otherwise fall through to <input> fallback
      }
    }
    fileRef.current?.click();
  }

  /** Re-read the previously-picked file for new rows — no picker (silent).
   *  Falls back to pickFile() if no handle is remembered or permission is denied. */
  async function silentRefresh() {
    if (!template) return;
    let handle = fileHandle;
    if (!handle) {
      handle = await loadHandle(template.id);
      if (handle) setFileHandle(handle);
    }
    if (!handle || !(await canRead(handle))) {
      await pickFile();
      return;
    }
    try {
      const file = await handle.getFile();
      const sheet = excel?.sheetName ?? "";
      if (sheet) await parseAndSetExcel(file, sheet); // same sheet, keeps mapping
      else await ingestFile(file);
    } catch {
      await pickFile(); // file moved/deleted → re-pick
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

  async function clearExcel() {
    setExcel(null);
    setSavedFilename("");
    setMapping({});
    setPerihalColMap("");
    setSelectedRows(new Set());
    setStep("setup");
    setFileHandle(null);
    if (template) {
      await clearHandle(template.id);
      await send({
        type: "template/update",
        id: template.id,
        updates: { mailMergeExcel: null as unknown as undefined, mailMergeMapping: null as unknown as undefined },
      });
    }
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

  function downloadResults() {
    const header = ["Baris", "ND ID", "Status", "Error"];
    const lines = results.map((r) => [
      String(r.origIndex + 1),
      r.ndId ? String(r.ndId) : "",
      r.error ? "Gagal" : "Berhasil",
      (r.error ?? "").replace(/"/g, '""'),
    ]);
    const csv = [header, ...lines].map((row) => row.map((c) => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mail-merge-results.csv";
    a.click();
    URL.revokeObjectURL(url);
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
    setShowRunConfirm(true);
  }

  function proceedToRun() {
    setShowRunConfirm(false);
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
        <button class="btn btn--ghost btn--sm back-btn" onClick={onBack}><Icon name="chevron-left" size={16} /> Kembali</button>
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
        <button class="btn btn--ghost btn--sm back-btn" onClick={onBack}><Icon name="chevron-left" size={16} /> Kembali</button>
        <h2 class="section-title">Mail Merge</h2>
        <StepIndicator step={step} />

        <div class="mm-info-card">
          <div class="mm-info-row"><span class="mm-info-label">Template</span><span>{template.name}</span></div>
          <div class="mm-info-row"><span class="mm-info-label">Perihal</span><span class="mm-info-value--muted">{getPerihal(template.payload)}</span></div>
          <div class="mm-info-row"><span class="mm-info-label">File ND</span><span><Icon name="file-text" size={15} /> {template.konsepFile.name}</span></div>
          {template.konsepNotaFile && (
            <div class="mm-info-row"><span class="mm-info-label">File NP</span><span><Icon name="file-text" size={15} /> {template.konsepNotaFile.name}</span></div>
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
            <div class="mm-info-row"><span class="mm-info-label">Pemetaan</span><span class="mm-saved-badge"><Icon name="check" size={14} /> Tersimpan</span></div>
          )}
        </div>

        <div class="field">
          <span class="field__label">Data Excel (.xlsx)</span>
          {excel ? (
            <div class="mm-excel-badge">
              <span><Icon name="bar-chart" size={15} /> {savedFilename} — {excel.sheetName} ({excel.rowCount} baris)</span>
              <button class="btn btn--ghost btn--xs" onClick={pickFile}>Ganti</button>
              <button class="btn btn--ghost btn--xs btn--danger-ghost" onClick={clearExcel} title="Hapus data Excel"><Icon name="x" size={14} /></button>
            </div>
          ) : (
            <button class="btn btn--ghost" onClick={pickFile}><Icon name="bar-chart" size={15} /> Pilih file Excel…</button>
          )}
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style="display:none" onChange={handleFileChange} />
          {fileError && <p class="error-text">{fileError}</p>}
        </div>

        <p class="hint">Baris pertama = nama kolom. Cocokkan dengan <code>{`{placeholder}`}</code> di file konsep.</p>

        {excel && (
          <div class="mm-mapping-actions">
            <button class="btn btn--primary" onClick={() => setStep("mapping")}>Lanjut ke Pemetaan <Icon name="chevron-right" size={16} /></button>
          </div>
        )}

        {/* Sheet picker modal */}
        {showSheetPicker && (
          <div class="modal-overlay">
            <div class="modal">
              <h2 class="modal__title"><Icon name="bar-chart" size={18} /> Pilih Sheet</h2>
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
        }}><Icon name="chevron-left" size={16} /> Kembali</button>
        <h2 class="section-title">Pemetaan Kolom</h2>
        <StepIndicator step={step} />

        <div class="mm-stats">
          {savedFilename && <><span><Icon name="bar-chart" size={14} /> {savedFilename}</span><span>·</span></>}
          <span><Icon name="clipboard-list" size={14} /> {excel.sheetName}</span><span>·</span>
          <span>{excel.rowCount} baris</span><span>·</span>
          <span>{excel.headers.length} kolom</span>
          <button class="btn btn--ghost btn--xs mm-change-file" onClick={pickFile}>Ganti file</button>
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
                  <span class={`mm-status ${matched ? "mm-status--ok" : "mm-status--warn"}`}>{matched ? <Icon name="check" size={14} /> : "!"}</span>
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
          <p class="hint" style="color: #d97706"><Icon name="alert" size={15} /> {unmatched.length} placeholder belum dipetakan</p>
        )}

        <div class="mm-mapping-actions">
          <button class="btn btn--ghost btn--sm" onClick={saveMapping} disabled={savingMapping || mappingSaved}>
            {savingMapping ? "Menyimpan…" : mappingSaved ? <><Icon name="check" size={14} /> Tersimpan</> : "Simpan Pemetaan"}
          </button>
          <button class="btn btn--primary" onClick={goToSelect}>Pilih Baris <Icon name="chevron-right" size={16} /></button>
        </div>
      </div>
    );
  }

  // ── Row Selection ──────────────────────────────────────
  if (step === "select" && excel) {
    const q = debouncedSearch.trim().toLowerCase();
    const filteredIndices = excel.rows.reduce<number[]>((acc, row, i) => {
      if (!q || excel.headers.some((h) => (row[h] ?? "").toLowerCase().includes(q))) acc.push(i);
      return acc;
    }, []);
    const filteredSelected = filteredIndices.filter((i) => selectedRows.has(i));
    const allFilteredSelected = filteredIndices.length > 0 && filteredSelected.length === filteredIndices.length;
    const unmatched = placeholders.filter((ph) => !mapping[ph] || !excel.headers.includes(mapping[ph]));

    return (
      <div class="view-template fade-in">
        <button class="btn btn--ghost btn--sm back-btn" onClick={onBack}><Icon name="chevron-left" size={16} /> Kembali</button>
        <h2 class="section-title">Pilih Baris</h2>
        <StepIndicator step={step} />

        <div class="mm-select-bar">
          <button class="btn btn--ghost btn--sm" onClick={() => allFilteredSelected ? doSelectNone(filteredIndices) : doSelectAll(filteredIndices)}>
            {allFilteredSelected ? <><Icon name="x" size={14} /> Batalkan</> : <><Icon name="check" size={14} /> Pilih Semua</>}{q ? " hasil filter" : ""}
          </button>
          <span class="mm-select-bar__counter">{selectedRows.size} / {excel.rowCount} dipilih</span>
          <button class="btn btn--ghost btn--xs" onClick={silentRefresh} title="Muat ulang untuk baris terbaru">
            <Icon name="refresh-cw" size={14} /> Muat Ulang
          </button>
          <button class="btn btn--ghost btn--xs btn--danger-ghost" onClick={clearExcel} title="Hapus data Excel">
            <Icon name="x" size={14} /> Hapus
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style="display:none" onChange={handleFileChange} />
          <button class="btn btn--ghost btn--xs" onClick={() => setStep("mapping")} title="Ubah pemetaan">
            <Icon name="pencil" size={14} /> Konfigurasi
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
            <Icon name="play" size={14} /> Jalankan {selectedRows.size} Baris
          </button>
        </div>

        {/* Run confirmation modal */}
        {showRunConfirm && (
          <div class="modal-overlay">
            <div class="modal">
              <h2 class="modal__title"><Icon name="play" size={18} /> Konfirmasi Batch</h2>
              <p class="modal__sub">{selectedRows.size} naskah akan dibuat dan dikirim ke Nadine.</p>
              {unmatched.length > 0 && (
                <p class="modal__hint" style="color: var(--error)"><Icon name="alert" size={14} /> {unmatched.length} placeholder belum dipetakan: {unmatched.join(", ")}</p>
              )}
              <div class="modal__actions">
                <button class="btn btn--ghost" onClick={() => setShowRunConfirm(false)}>Batal</button>
                <button class="btn btn--primary" onClick={proceedToRun}><Icon name="play" size={14} /> Jalankan {selectedRows.size} Baris</button>
              </div>
            </div>
          </div>
        )}

        {/* NP penandatangan picker modal */}
        {showNpPicker && (
          <div class="modal-overlay">
            <div class="modal">
              <h2 class="modal__title"><Icon name="memo" size={18} /> Pilih Penandatangan NP</h2>
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
        {step === "done" && <button class="btn btn--ghost btn--sm back-btn" onClick={onBack}><Icon name="chevron-left" size={16} /> Kembali</button>}
        <h2 class="section-title">
          {step === "running"
            ? <><Icon name="loader" size={16} /> {`Menjalankan… (${currentRow}/${totalRows})`}</>
            : summary?.failed ? <><Icon name="alert" size={16} /> Selesai</> : <><Icon name="circle-check" size={16} /> Selesai</>}
        </h2>
        <StepIndicator step={step} />
        {step === "running" && <ProgressBar value={currentRow} max={totalRows} />}

        {summary && (
          <>
            <div class="mm-summary">
              <span class="mm-summary__ok"><Icon name="check" size={14} /> {summary.success} berhasil</span>
              {summary.failed > 0 && <span class="mm-summary__err"><Icon name="x" size={14} /> {summary.failed} gagal</span>}
            </div>
            {step === "done" && results.length > 0 && (
              <button class="btn btn--ghost btn--sm" onClick={downloadResults} style="margin-top:6px"><Icon name="download" size={14} /> Unduh Hasil (CSV)</button>
            )}
          </>
        )}

        <div class="mm-progress">
          {results.map((r) => (
            <div key={r.portIndex} class={`mm-progress__row ${r.error ? "mm-progress__row--err" : "mm-progress__row--ok"}`}>
              <div class="mm-progress__header">
                <span class="mm-progress__icon">{r.error ? <Icon name="x" size={14} /> : <Icon name="check" size={14} />}</span>
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
                <span class="mm-progress__icon"><Icon name="loader" size={14} /></span>
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
