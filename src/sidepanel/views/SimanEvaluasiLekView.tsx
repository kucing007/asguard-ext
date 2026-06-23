import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../components/Icon";
import { mergeLek, type MergeProgress, type MergeStats } from "../lek/lek-merge";
import {
  clearLekTemplate,
  getLekTemplateBytes,
  getLekTemplateMeta,
  saveLekTemplate,
  type LekTemplateMeta,
} from "../lek/lek-template-store";

const iconText = "display:inline-flex;align-items:center;gap:4px";

export function SimanEvaluasiLekView() {
  const [savedTemplate, setSavedTemplate] = useState<LekTemplateMeta | null>(null);
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [datasourceFile, setDatasourceFile] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; stats: MergeStats } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const templateRef = useRef<HTMLInputElement>(null);
  const dsRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const hasTemplate = !!templateFile || !!savedTemplate;
  const canStart = hasTemplate && !!datasourceFile && !running;

  useEffect(() => {
    getLekTemplateMeta().then(setSavedTemplate);
  }, []);

  function push(line: string) {
    setLogs((p) => [...p, line]);
    setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 30);
  }

  function onProgress(p: MergeProgress) {
    push(`${p.phase}${p.detail ? " — " + p.detail : ""}`);
  }

  async function clearSaved() {
    await clearLekTemplate();
    setSavedTemplate(null);
    setTemplateFile(null);
    setResult(null);
    setError(null);
  }

  async function start() {
    if (running || !datasourceFile) return;
    setRunning(true);
    setLogs([]);
    setResult(null);
    setError(null);
    try {
      push("━━━ Automasi LEK Docx ━━━");
      // Resolve template bytes: a freshly-uploaded file wins and is then saved
      // for reuse; otherwise fall back to the persisted template.
      let template: ArrayBuffer | null;
      if (templateFile) {
        template = await templateFile.arrayBuffer();
        push("Menyimpan template baku…");
        const meta = await saveLekTemplate(templateFile);
        if (meta) {
          setSavedTemplate(meta);
        } else {
          push("⚠ Gagal menyimpan template (kuota penuh) — unggah ulang lain kali.");
        }
        setTemplateFile(null);
      } else {
        template = await getLekTemplateBytes();
      }
      if (!template) throw new Error("Unggah template baku terlebih dahulu.");
      const datasource = await datasourceFile.arrayBuffer();
      const { bytes, stats } = await mergeLek(datasource, template, onProgress);
      push(`━━━ Selesai: ${stats.filledTables} tabel diisi, ${stats.matchedSections}/${stats.templateSections} bagian cocok ━━━`);
      const stem = datasourceFile.name.replace(/\.docx$/i, "");
      setResult({ bytes, name: `${stem}_OUTPUT.docx`, stats });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      push(`❌ ${msg}`);
    } finally {
      setRunning(false);
    }
  }

  function download() {
    if (!result) return;
    const blob = new Blob([new Uint8Array(result.bytes)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.name;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style="padding:8px;display:flex;flex-direction:column;gap:8px">
      {/* Template baku */}
      <div class="card" style="padding:10px">
        <div style={`font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:6px;${iconText}`}>
          <Icon name="file-text" size={14} /> Template Baku (format baku)
        </div>
        <input
          ref={templateRef}
          type="file"
          accept=".docx"
          style="display:none"
          onChange={(e) => { setTemplateFile((e.target as HTMLInputElement).files?.[0] ?? null); setError(null); setResult(null); }}
        />
        {templateFile ? (
          <div style={`font-size:11px;color:var(--color-primary);${iconText}`}>
            <Icon name="check" size={14} /> {templateFile.name} <span style="color:var(--muted)">(akan disimpan)</span>
          </div>
        ) : savedTemplate ? (
          <div style={`font-size:11px;color:var(--color-primary);${iconText}`}>
            <Icon name="check" size={14} /> Tersimpan: {savedTemplate.name}
          </div>
        ) : (
          <p style="font-size:11px;color:var(--muted);margin:0 0 8px">
            Unggah template baku sekali; akan disimpan untuk dipakai ulang.
          </p>
        )}
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="btn btn--ghost" style={`flex:1;font-size:11px;padding:6px 12px;${iconText}`} onClick={() => templateRef.current?.click()} disabled={running}>
            <Icon name="folder-open" size={14} /> {hasTemplate ? "Ganti Template" : "Pilih Template (.docx)"}
          </button>
          {savedTemplate && (
            <button class="btn btn--ghost" style={`font-size:11px;padding:6px 12px;${iconText}`} onClick={clearSaved} disabled={running}>
              <Icon name="trash" size={14} /> Hapus
            </button>
          )}
        </div>
      </div>

      {/* Datasource */}
      <div class="card" style="padding:10px">
        <div style={`font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:6px;${iconText}`}>
          <Icon name="upload" size={14} /> Datasource LEK (dari SIMAN)
        </div>
        <p style="font-size:11px;color:var(--muted);margin:0 0 8px">
          File LEK mentah hasil unduhan dari SIMAN.
        </p>
        <input
          ref={dsRef}
          type="file"
          accept=".docx"
          style="display:none"
          onChange={(e) => { setDatasourceFile((e.target as HTMLInputElement).files?.[0] ?? null); setError(null); setResult(null); }}
        />
        <button class="btn btn--ghost" style={`font-size:11px;padding:6px 12px;width:100%;${iconText}`} onClick={() => dsRef.current?.click()} disabled={running}>
          <Icon name="folder-open" size={14} /> {datasourceFile ? datasourceFile.name : "Pilih File (.docx)"}
        </button>
        {datasourceFile && (
          <div style={`margin-top:6px;font-size:11px;color:var(--color-primary);${iconText}`}>
            <Icon name="check" size={14} /> {(datasourceFile.size / 1024).toFixed(0)} KB
          </div>
        )}
      </div>

      {/* Start */}
      <div class="card" style="padding:10px">
        <button
          class="btn btn--primary"
          style={`font-size:12px;padding:8px 16px;width:100%;${iconText}${!canStart ? ";opacity:0.5" : ""}`}
          onClick={start}
          disabled={!canStart}
        >
          {running ? <><Icon name="loader" size={14} /> Memproses…</> : <><Icon name="play" size={14} /> Mulai</>}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={`font-size:11px;padding:8px;border-radius:var(--radius-sm);background:color-mix(in srgb, var(--error) 10%, transparent);color:var(--error);${iconText}`}>
          <Icon name="alert" size={14} /> {error}
        </div>
      )}

      {/* Result */}
      {result && (
        <div class="card" style="padding:10px">
          <div style={`font-size:12px;padding:8px;border-radius:var(--radius-sm);background:color-mix(in srgb, #16a34a 10%, transparent);color:#16a34a;text-align:center;font-weight:600;margin-bottom:8px;${iconText};justify-content:center`}>
            <Icon name="circle-check" size={14} /> Output siap
          </div>
          <button class="btn btn--primary" style={`font-size:11px;padding:6px 12px;width:100%;${iconText}`} onClick={download}>
            <Icon name="download" size={14} /> Download {result.name}
          </button>
        </div>
      )}

      {/* Logs */}
      {logs.length > 0 && (
        <div class="card" style="padding:10px">
          <div style={`font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:6px;${iconText}`}>
            <Icon name="clipboard-list" size={14} /> Log Proses
          </div>
          <div
            ref={logRef}
            style="max-height:400px;overflow-y:auto;font-family:monospace;font-size:10px;line-height:1.6;padding:8px;background:#0d1117;border-radius:var(--radius-sm);color:#c9d1d9;white-space:pre-wrap;word-break:break-all"
          >
            {logs.map((l, i) => (
              <div
                key={i}
                style={
                  l.includes("❌") || l.includes("✗")
                    ? "color:#f85149"
                    : l.includes("━━━")
                      ? "color:#58a6ff;font-weight:bold"
                      : l.includes("Selesai")
                        ? "color:#3fb950;font-weight:bold"
                        : undefined
                }
              >
                {l}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
