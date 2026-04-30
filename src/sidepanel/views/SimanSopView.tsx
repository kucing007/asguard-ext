import { useState, useEffect, useRef } from "preact/hooks";
import type { SimanSopTarikPortRequest, SimanSopTarikMsg, SopExportRow, SimanTokenState } from "@/shared/types";
import * as XLSX from "xlsx";

interface KanwilItem { id_kanwil: number; ur_kanwil: string; kd_kanwil: string }
interface KpknlItem { id_kpknl: number; kdkpknl: string; urkpknl: string }
type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

const COLUMNS: { key: keyof SopExportRow; label: string }[] = [
  { key: "no_tiket", label: "No Tiket" },
  { key: "no_sk", label: "No SK" },
  { key: "tgl_sk", label: "Tgl SK" },
  { key: "ur_satker", label: "Satker" },
  { key: "kd_satker", label: "Kode Satker" },
  { key: "pemohon", label: "Pemohon" },
  { key: "ur_kl", label: "Kementerian/Lembaga" },
  { key: "nama_tipe_pengelolaan", label: "Tipe Pengelolaan" },
  { key: "tgl_dokumen_diterima", label: "Tanggal Dokumen Diterima" },
  { key: "kategori_bmn", label: "Kategori BMN" },
];

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

export function SimanSopView() {
  const [tahunAnggaran, setTahunAnggaran] = useState(String(new Date().getFullYear()));

  // Kanwil / KPKNL
  const [kanwilList, setKanwilList] = useState<KanwilItem[]>([]);
  const [kpknlList, setKpknlList] = useState<KpknlItem[]>([]);
  const [selectedKanwil, setSelectedKanwil] = useState(0);
  const [selectedKpknl, setSelectedKpknl] = useState(0);
  const [filteredKpknl, setFilteredKpknl] = useState<KpknlItem[]>([]);
  const [loadingRef, setLoadingRef] = useState(true);

  // Run state
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [skProgress, setSkProgress] = useState<{ done: number; total: number } | null>(null);
  const [detailProgress, setDetailProgress] = useState<{ done: number; total: number; noTiket: string } | null>(null);
  const [rows, setRows] = useState<SopExportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => () => { portRef.current?.disconnect(); }, []);

  // Load reference data + role context on mount
  useEffect(() => {
    (async () => {
      const [kanwilRes, kpknlRes, stateRes] = await Promise.all([
        send<ApiResult<KanwilItem[]>>({ type: "siman/get-kanwil-list" }),
        send<ApiResult<KpknlItem[]>>({ type: "siman/get-kpknl-list" }),
        send<{ simanToken?: SimanTokenState }>({ type: "state/get" }),
      ]);
      const kw = kanwilRes.ok ? kanwilRes.data : [];
      const kp = kpknlRes.ok ? kpknlRes.data : [];
      setKanwilList(kw);
      setKpknlList(kp);

      // Auto-select from role context
      const role = stateRes.simanToken?.role;
      const roleKpknlId = Number(role?.idKpknl) || 0;
      const roleKanwilId = Number(role?.idKanwil) || 0;

      if (roleKpknlId && kp.some((k) => k.id_kpknl === roleKpknlId)) {
        // Role has a valid KPKNL — derive kanwil from kdkpknl prefix
        const match = kp.find((k) => k.id_kpknl === roleKpknlId);
        if (match) {
          const prefix = match.kdkpknl.slice(0, 2);
          const kwMatch = kw.find((k) => k.kd_kanwil === prefix);
          const kwId = kwMatch?.id_kanwil ?? roleKanwilId;
          setSelectedKanwil(kwId);
          setFilteredKpknl(kp.filter((k) => k.kdkpknl.startsWith(prefix)));
          setSelectedKpknl(roleKpknlId);
        }
      } else if (roleKanwilId && kw.some((k) => k.id_kanwil === roleKanwilId)) {
        // Role has kanwil but no kpknl — just set kanwil
        const kwMatch = kw.find((k) => k.id_kanwil === roleKanwilId);
        if (kwMatch) {
          setSelectedKanwil(roleKanwilId);
          setFilteredKpknl(kp.filter((k) => k.kdkpknl.startsWith(kwMatch.kd_kanwil)));
        }
      }
      setLoadingRef(false);
    })();
  }, []);

  function onKanwilChange(idKanwil: number) {
    setSelectedKanwil(idKanwil);
    setSelectedKpknl(0);
    if (!idKanwil) { setFilteredKpknl([]); return; }
    const kw = kanwilList.find((k) => k.id_kanwil === idKanwil);
    if (kw) setFilteredKpknl(kpknlList.filter((k) => k.kdkpknl.startsWith(kw.kd_kanwil)));
  }

  function start() {
    if (running || !selectedKpknl) return;
    setRunning(true);
    setError(null);
    setRows(null);
    setStatus("Menghubungkan…");
    setSkProgress(null);
    setDetailProgress(null);

    const port = chrome.runtime.connect({ name: "siman-sop-tarik" });
    portRef.current = port;

    port.onMessage.addListener((msg: SimanSopTarikMsg) => {
      if (msg.type === "sop/status") setStatus(msg.message);
      if (msg.type === "sop/sk-progress") setSkProgress({ done: msg.done, total: msg.total });
      if (msg.type === "sop/detail-progress") setDetailProgress({ done: msg.done, total: msg.total, noTiket: msg.noTiket });
      if (msg.type === "sop/rows") setRows(msg.rows);
      if (msg.type === "sop/done") { setRunning(false); setStatus(""); }
      if (msg.type === "sop/error") { setError(msg.error); setRunning(false); setStatus(""); }
    });

    port.onDisconnect.addListener(() => { setRunning(false); });

    const req: SimanSopTarikPortRequest = {
      type: "siman/sop-tarik-run",
      tahunAnggaran,
      idKanwil: selectedKanwil,
      idKpknl: selectedKpknl,
    };
    port.postMessage(req);
  }

  function downloadXlsx() {
    if (!rows) return;
    const sheetData = [
      COLUMNS.map((c) => c.label),
      ...rows.map((r) => COLUMNS.map((c) => String(r[c.key] ?? ""))),
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    ws["!cols"] = COLUMNS.map((col) => {
      let maxLen = col.label.length;
      for (const row of rows) {
        const val = String(row[col.key] ?? "");
        if (val.length > maxLen) maxLen = Math.min(val.length, 50);
      }
      return { wch: maxLen + 2 };
    });
    XLSX.utils.book_append_sheet(wb, ws, "SOP Pengelolaan BMN");
    XLSX.writeFile(wb, `SOP_Pengelolaan_BMN_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  const selectStyle = "width:100%;font-size:12px;padding:5px 8px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary);box-sizing:border-box";
  const inputStyle = selectStyle;
  const labelStyle = "font-size:11px;color:var(--muted);display:block;margin-bottom:3px";

  return (
    <div style="padding:12px;display:flex;flex-direction:column;gap:10px">
      {/* Kanwil */}
      <div>
        <label style={labelStyle}>Kanwil</label>
        <select style={selectStyle} value={selectedKanwil} onChange={(e) => onKanwilChange(Number((e.target as HTMLSelectElement).value))} disabled={running || loadingRef}>
          <option value={0}>{loadingRef ? "Memuat…" : "— Pilih Kanwil —"}</option>
          {kanwilList.map((k) => <option key={k.id_kanwil} value={k.id_kanwil}>{k.ur_kanwil}</option>)}
        </select>
      </div>

      {/* KPKNL */}
      <div>
        <label style={labelStyle}>KPKNL</label>
        <select style={selectStyle} value={selectedKpknl} onChange={(e) => setSelectedKpknl(Number((e.target as HTMLSelectElement).value))} disabled={running || !selectedKanwil}>
          <option value={0}>— Pilih KPKNL —</option>
          {filteredKpknl.map((k) => <option key={k.id_kpknl} value={k.id_kpknl}>{k.urkpknl}</option>)}
        </select>
      </div>

      {/* Tahun + Mulai */}
      <div style="display:flex;gap:8px;align-items:flex-end">
        <div style="flex:1">
          <label style={labelStyle}>Tahun Anggaran</label>
          <input type="text" value={tahunAnggaran} onInput={(e) => setTahunAnggaran((e.target as HTMLInputElement).value)} style={inputStyle} placeholder="2026" disabled={running} />
        </div>
        <button class="btn btn--primary" style="flex-shrink:0;font-size:12px;padding:6px 14px" onClick={start} disabled={running || !selectedKpknl || !tahunAnggaran.trim()}>
          {running ? "Memproses…" : "Mulai"}
        </button>
      </div>

      {/* Progress */}
      {running && (
        <div style="display:flex;flex-direction:column;gap:6px">
          {status && <p class="hint" style="margin:0">{status}</p>}
          {skProgress && (
            <div>
              <div style="font-size:11px;color:var(--muted);margin-bottom:3px">SK: {skProgress.done} / {skProgress.total || "?"}</div>
              <ProgressBar value={skProgress.done} max={skProgress.total || skProgress.done} />
            </div>
          )}
          {detailProgress && (
            <div>
              <div style="font-size:11px;color:var(--muted);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                Detail {detailProgress.done}/{detailProgress.total}: {detailProgress.noTiket}
              </div>
              <ProgressBar value={detailProgress.done} max={detailProgress.total} />
            </div>
          )}
        </div>
      )}

      {error && <p class="hint" style="color:var(--error);margin:0">{error}</p>}

      {/* Results */}
      {rows !== null && !running && (
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:12px;color:var(--text-primary);font-weight:600">{rows.length} SK ditemukan</span>
            <button class="btn btn--primary" style="font-size:11px;padding:5px 12px" onClick={downloadXlsx} disabled={!rows.length}>⬇ Unduh XLSX</button>
          </div>
          {rows.length === 0 && <p class="hint">Tidak ada data SK untuk tahun {tahunAnggaran}.</p>}
          {rows.length > 0 && (
            <div style="font-size:10px;color:var(--muted)">
              {rows.slice(0, 3).map((r, i) => (
                <div key={i} style="padding:3px 0;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                  {r.no_tiket} · {r.nama_tipe_pengelolaan}
                </div>
              ))}
              {rows.length > 3 && <div style="padding-top:3px">+{rows.length - 3} lainnya…</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div style="height:4px;background:var(--surface-2);border-radius:2px;overflow:hidden">
      <div style={`width:${pct}%;height:100%;background:var(--color-primary);transition:width 0.2s`} />
    </div>
  );
}
