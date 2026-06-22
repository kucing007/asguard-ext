import { useState, useEffect, useRef } from "preact/hooks";
import type { SimanEvalMsg, SimanEvalPortRequest } from "@/shared/siman-types";
import * as XLSX from "xlsx";
import { Icon } from "../components/Icon";

const iconText = "display:inline-flex;align-items:center;gap:4px";

function send<T>(msg: unknown): Promise<T> { return chrome.runtime.sendMessage(msg) as Promise<T>; }

const TEMPLATE_HEADERS = ["kd_brg","no_aset","cara_evaluasi","tgl_survey","111111","121111","121211","121311","121411","121511","131111","131211","131311","131411","131511","131611","131711","141111","141211","151211","151212","151213","151214","151215","161111"];

interface Props { noPaket: string; onBack: () => void }

export function SimanEvaluasiDetailView({ noPaket }: Props) {
  const [asets, setAsets] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAutomasi, setShowAutomasi] = useState(false);

  useEffect(() => { loadAsets(); }, [noPaket]);
  async function loadAsets() {
    setLoading(true); setError(null);
    try {
      const r = await send<{ ok: boolean; data?: Record<string, unknown>[]; error?: string }>({ type: "eval/aset-list", noPaket });
      if (r.ok) setAsets(r.data ?? []); else setError(r.error ?? "Gagal");
    } catch (e) { setError(String(e)); }
    setLoading(false);
  }

  const first = asets[0] as Record<string, unknown> | undefined;

  return (
    <div style="padding:8px;display:flex;flex-direction:column;gap:8px">
      {/* Header */}
      <div class="card" style="padding:10px">
        <div style="font-weight:600;font-size:13px;color:var(--color-primary)">{noPaket}</div>
        {first && <div style="font-size:11px;color:var(--text-primary);margin-top:2px">{String(first.ur_satker ?? "")}</div>}
        <div style="font-size:10px;color:var(--muted);margin-top:2px">{asets.length} aset</div>
      </div>

      {/* Toggle buttons */}
      <div style="display:flex;gap:6px">
        <button class={`btn ${!showAutomasi ? "btn--primary" : "btn--ghost"}`} style={`flex:1;font-size:11px;padding:6px;${iconText}`} onClick={() => setShowAutomasi(false)}><Icon name="clipboard-list" size={14} /> Daftar Aset</button>
        <button class={`btn ${showAutomasi ? "btn--primary" : "btn--ghost"}`} style={`flex:1;font-size:11px;padding:6px;${iconText}`} onClick={() => setShowAutomasi(true)}><Icon name="bot" size={14} /> Otomasi Pengisian</button>
      </div>

      {showAutomasi ? (
        <AutomasiSection noPaket={noPaket} asets={asets} onDone={loadAsets} />
      ) : (
        <>
          {loading && <p class="hint">Memuat aset…</p>}
          {error && <p class="hint" style="color:var(--error)">{error}</p>}
          {!loading && asets.map((aset) => {
            const id = String(aset.id_siap_bmn ?? "");
            return <AsetCard key={id} aset={aset} expanded={expanded === id} onToggle={() => setExpanded(expanded === id ? null : id)} onRefresh={loadAsets} />;
          })}
          {!loading && !asets.length && !error && <p class="hint">Tidak ada aset.</p>}
        </>
      )}
    </div>
  );
}

// ============ AUTOMASI SECTION ============

function AutomasiSection({ noPaket, asets, onDone }: { noPaket: string; asets: Record<string, unknown>[]; onDone: () => void }) {
  const [excelRows, setExcelRows] = useState<Record<string, string>[] | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<{ success: number; failed: number } | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => { portRef.current?.disconnect(); }, []);

  function downloadTemplate() {
    const wb = XLSX.utils.book_new();
    // Header row
    const data: string[][] = [TEMPLATE_HEADERS];
    // Pre-fill with aset data
    for (const a of asets) {
      const row: string[] = [String(a.kd_brg ?? ""), String(a.no_aset ?? ""), "On Desk", "", ...Array(21).fill("")];
      data.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws["!cols"] = TEMPLATE_HEADERS.map((h) => ({ wch: h.length < 10 ? 14 : h.length + 4 }));
    XLSX.utils.book_append_sheet(wb, ws, "Data Evaluasi");
    XLSX.writeFile(wb, `evaluasi_template_${noPaket}.xlsx`);
  }

  function handleFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const wb = XLSX.read(ev.target?.result, { type: "array" });
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]], { raw: false });
      setExcelRows(rows);
      setResult(null);
      setLogs([]);
    };
    reader.readAsArrayBuffer(file);
  }

  function start() {
    if (running || !excelRows) return;
    setRunning(true); setLogs([]); setResult(null);
    const port = chrome.runtime.connect({ name: "siman-evaluasi" });
    portRef.current = port;
    port.onMessage.addListener((msg: SimanEvalMsg) => {
      if (msg.type === "eval/log") { setLogs((p) => [...p, msg.message]); setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 30); }
      if (msg.type === "eval/done") { setRunning(false); setResult({ success: msg.success, failed: msg.failed }); onDone(); }
      if (msg.type === "eval/error") { setRunning(false); setLogs((p) => [...p, `❌ ${msg.error}`]); }
    });
    port.onDisconnect.addListener(() => setRunning(false));
    port.postMessage({ type: "siman/eval-run", noPaket, excelRows } as SimanEvalPortRequest);
  }

  return (
    <div style="display:flex;flex-direction:column;gap:8px">
      {/* 1. Download Template */}
      <div class="card" style="padding:10px">
        <div style={`font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:6px;${iconText}`}><Icon name="download" size={14} /> Download Template</div>
        <p style="font-size:11px;color:var(--muted);margin:0 0 8px">Template Excel sudah terisi kd_brg dan no_aset dari {asets.length} aset dalam paket ini.</p>
        <button class="btn btn--primary" style={`font-size:11px;padding:6px 12px;width:100%;${iconText}`} onClick={downloadTemplate}>
          <Icon name="download" size={14} /> Download Template Excel
        </button>
      </div>

      {/* 2. Upload Excel */}
      <div class="card" style="padding:10px">
        <div style={`font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:6px;${iconText}`}><Icon name="upload" size={14} /> Upload Excel</div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style="display:none" />
        <button class="btn btn--ghost" style={`font-size:11px;padding:6px 12px;width:100%;${iconText}`} onClick={() => fileRef.current?.click()} disabled={running}>
          <Icon name="folder-open" size={14} /> Pilih File Excel (.xlsx)
        </button>
        {excelRows && (
          <div style={`margin-top:6px;font-size:11px;color:var(--color-primary);${iconText}`}><Icon name="check" size={14} /> {excelRows.length} baris data dimuat</div>
        )}
      </div>

      {/* 3. Tutorial */}
      <div class="card" style="padding:10px">
        <div style={`font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:6px;${iconText}`}><Icon name="book-open" size={14} /> Panduan Pengisian</div>
        <div style="font-size:10px;color:var(--muted);display:flex;flex-direction:column;gap:4px">
          <div><strong>kd_brg</strong> & <strong>no_aset</strong> — Jangan diubah, digunakan untuk mencocokkan aset</div>
          <div><strong>cara_evaluasi</strong> — "On Desk" atau "Peninjauan Lapangan"</div>
          <div><strong>tgl_survey</strong> — Format: YYYY-MM-DD (contoh: 2026-05-01)</div>
          <div><strong>111111</strong> (Kepentingan Umum) — Isi teks pilihan dari SIMAN</div>
          <div><strong>121111–121511</strong> (Manfaat Sosial) — Isi angka</div>
          <div><strong>131111–131711</strong> (Kepuasan) — Isi teks pilihan dari SIMAN</div>
          <div><strong>141111–141211</strong> (Potensi Penggunaan) — Isi teks pilihan</div>
          <div><strong>151211–151215</strong> (Kelayakan Biaya) — Isi angka (Rp)</div>
          <div><strong>161111</strong> (Kondisi Teknis) — Isi teks pilihan</div>
          <div style="margin-top:4px;padding-top:4px;border-top:1px solid var(--line)">
            <strong>Kolom kosong akan di-skip.</strong> 151216 (Aset Non Komersial) dihitung otomatis.
            Score Card BMN dan status SELESAI diproses otomatis di akhir.
          </div>
        </div>
      </div>

      {/* 4. Start */}
      <div class="card" style="padding:10px">
        <button
          class="btn btn--primary"
          style={`font-size:12px;padding:8px 16px;width:100%;${iconText}${!excelRows || running ? ";opacity:0.5" : ""}`}
          onClick={start}
          disabled={!excelRows || running}
        >
          {running ? <><Icon name="loader" size={14} /> Memproses…</> : <><Icon name="play" size={14} /> Mulai Otomasi</>}
        </button>
        {result && (
          <div style={`margin-top:8px;font-size:12px;padding:8px;border-radius:var(--radius-sm);background:color-mix(in srgb, #16a34a 10%, transparent);color:#16a34a;text-align:center;font-weight:600;${iconText};justify-content:center`}>
            <Icon name="circle-check" size={14} /> Selesai: {result.success} berhasil, {result.failed} gagal
          </div>
        )}
      </div>

      {/* 5. Logs */}
      {logs.length > 0 && (
        <div class="card" style="padding:10px">
          <div style={`font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:6px;${iconText}`}><Icon name="clipboard-list" size={14} /> Log Proses</div>
          <div
            ref={logRef}
            style="max-height:400px;overflow-y:auto;font-family:monospace;font-size:10px;line-height:1.6;padding:8px;background:#0d1117;border-radius:var(--radius-sm);color:#c9d1d9;white-space:pre-wrap;word-break:break-all"
          >
            {logs.map((l, i) => (
              <div key={i} style={l.includes("✓") ? "color:#3fb950" : l.includes("✗") || l.includes("❌") ? "color:#f85149" : l.includes("━━━") ? "color:#58a6ff;font-weight:bold" : l.includes("⏭") ? "color:#8b949e" : l.includes("✅") ? "color:#3fb950;font-weight:bold" : undefined}>{l}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============ ASET CARD ============

function AsetCard({ aset, expanded, onToggle, onRefresh }: { aset: Record<string, unknown>; expanded: boolean; onToggle: () => void; onRefresh: () => void }) {
  const [saving, setSaving] = useState<string | null>(null);
  const [caraEval, setCaraEval] = useState(String(aset.cara_evaluasi ?? "On Desk"));
  const [tglSurvey, setTglSurvey] = useState(String(aset.tgl_survey ?? "").slice(0, 10));
  const [indikators, setIndikators] = useState<Record<string, unknown>[] | null>(null);
  const [indLoading, setIndLoading] = useState(false);

  const kdBrg = String(aset.kd_brg ?? "");
  const nup = String(aset.no_aset ?? "");
  const urSskel = String(aset.ur_sskel ?? "");
  const kinerja = String(aset.kinerja_aset ?? "");
  const statusEval = String(aset.status_evaluasi ?? "");
  const isSelesai = statusEval === "SELESAI";

  async function loadInd() { setIndLoading(true); const r = await send<{ ok: boolean; data?: Record<string, unknown>[] }>({ type: "eval/laksana", idSiapBmn: String(aset.id_siap_bmn) }); if (r.ok) setIndikators(r.data ?? []); setIndLoading(false); }
  useEffect(() => { if (expanded && !indikators) loadInd(); }, [expanded]);

  async function act(key: string, fn: () => Promise<void>) { setSaving(key); try { await fn(); } catch { /* */ } setSaving(null); }

  const groups: Record<string, Record<string, unknown>[]> = {};
  if (indikators) for (const ind of indikators) { const k = `${ind.kd_indikator} - ${ind.ur_indikator}`; (groups[k] ??= []).push(ind); }

  return (
    <div class="card" style="padding:10px">
      <div style="display:flex;align-items:center;gap:8px;cursor:pointer" onClick={onToggle}>
        <span class={`dot ${isSelesai ? "dot--ok" : "dot--warn"}`} style="flex-shrink:0" />
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{kdBrg} · NUP {nup}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{urSskel}</div>
        </div>
        {kinerja && <span style={`font-size:10px;padding:2px 6px;border-radius:8px;font-weight:600;flex-shrink:0;${kinerja.includes("BAIK") ? "background:color-mix(in srgb, #16a34a 15%, transparent);color:#16a34a" : kinerja === "BURUK" ? "background:color-mix(in srgb, #ef4444 15%, transparent);color:#ef4444" : "background:var(--surface-2);color:var(--text-primary)"}`}>{kinerja}</span>}
        <span style="color:var(--muted);flex-shrink:0;display:inline-flex;align-items:center">{expanded ? <Icon name="arrow-up" size={13} /> : <Icon name="arrow-down" size={13} />}</span>
      </div>

      {expanded && (
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;gap:6px;align-items:center">
            <label style="font-size:10px;color:var(--muted);width:65px;flex-shrink:0">Cara Eval</label>
            <select style="flex:1;font-size:11px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)" value={caraEval} onChange={(e) => setCaraEval((e.target as HTMLSelectElement).value)}>
              <option value="On Desk">On Desk</option>
              <option value="Peninjauan Lapangan">Peninjauan Lapangan</option>
            </select>
            <button class="btn btn--ghost" style="font-size:10px;padding:3px 8px;display:inline-flex;align-items:center" onClick={() => act("cara", () => send({ type: "eval/edit-evaluasi", aset, caraEvaluasi: caraEval }))} disabled={!!saving}>{saving === "cara" ? "…" : <Icon name="save" size={13} />}</button>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <label style="font-size:10px;color:var(--muted);width:65px;flex-shrink:0">Tgl Survey</label>
            <input type="date" value={tglSurvey} onInput={(e) => setTglSurvey((e.target as HTMLInputElement).value)} style="flex:1;font-size:11px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)" />
            <button class="btn btn--ghost" style="font-size:10px;padding:3px 8px;display:inline-flex;align-items:center" onClick={() => act("tgl", () => send({ type: "eval/edit-survey", aset, tglSurvey }))} disabled={!!saving}>{saving === "tgl" ? "…" : <Icon name="save" size={13} />}</button>
          </div>

          {/* Indikator */}
          <div style="padding-top:4px;border-top:1px solid var(--line)">
            <div style="font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:6px">Indikator</div>
            {indLoading && <p class="hint" style="font-size:10px">Memuat…</p>}
            {indikators && Object.entries(groups).map(([g, items]) => (
              <div key={g} style="margin-bottom:6px">
                <div style="font-size:10px;font-weight:600;color:var(--color-primary);margin-bottom:3px">{g}</div>
                {items.map((ind, j) => { const kd = String(ind.kd_sub_sub ?? ""); const color = String(ind.score_color ?? "").toLowerCase(); return (
                  <div key={j} style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:10px;border-bottom:1px solid var(--line)">
                    <span class={`dot ${color.includes("hijau") || color === "green" ? "dot--ok" : color.includes("merah") || color === "red" ? "dot--err" : ""}`} style="flex-shrink:0" />
                    <span style="color:var(--muted);width:50px;flex-shrink:0">{kd}</span>
                    <span style="flex:1;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{String(ind.ur_sub_sub ?? "")}</span>
                    <span style="color:var(--text-primary);flex-shrink:0">{String(ind.nilai_sub_sub2 ?? "") || (ind.nilai_sub_sub ? String(ind.nilai_sub_sub) : "—")}</span>
                    {ind.skor && <span style="color:var(--muted);flex-shrink:0">(s:{String(ind.skor)})</span>}
                  </div>
                ); })}
              </div>
            ))}
          </div>

          {/* Actions */}
          <div style="display:flex;flex-wrap:wrap;gap:6px;padding-top:4px;border-top:1px solid var(--line)">
            <button class="btn btn--ghost" style={`font-size:11px;padding:5px 10px;${iconText}`} onClick={() => act("gen15", async () => { await send({ type: "eval/generate15", aset }); loadInd(); })} disabled={!!saving}>{saving === "gen15" ? "…" : <><Icon name="bar-chart" size={13} /> Generate Ind.15</>}</button>
            <button class="btn btn--primary" style={`font-size:11px;padding:5px 10px;${iconText}`} onClick={() => act("selesai", async () => { await send({ type: "eval/edit-status", aset }); onRefresh(); })} disabled={!!saving}>{saving === "selesai" ? "…" : <><Icon name="circle-check" size={13} /> Selesaikan</>}</button>
          </div>
        </div>
      )}
    </div>
  );
}
