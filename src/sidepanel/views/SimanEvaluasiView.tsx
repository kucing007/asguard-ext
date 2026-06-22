import { useState, useEffect, useRef } from "preact/hooks";
import { Icon } from "../components/Icon";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

const STATUS_OPTIONS = [
  { label: "Semua", value: "" },
  { label: "PROSES", value: "PROSES" },
  { label: "SELESAI", value: "SELESAI" },
];
const LIMIT = 10;

interface Props { onSelect: (noPaket: string) => void }

export function SimanEvaluasiView({ onSelect }: Props) {
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [tahun, setTahun] = useState(String(new Date().getFullYear()));
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqSeq = useRef(0);

  useEffect(() => { fetchPage(0); }, [statusFilter, tahun]);

  async function fetchPage(p: number) {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await send<{ ok: boolean; data?: { data: Record<string, unknown>[]; total: number }; error?: string }>({
        type: "eval/paket-list", limit: LIMIT, offset: p * LIMIT,
        tahun: tahun ? Number(tahun) : undefined,
        statusPaket: statusFilter || undefined,
      });
      if (seq !== reqSeq.current) return;
      if (r.ok && r.data) { setItems(r.data.data); setTotal(r.data.total); setPage(p); }
      else setError(r.error ?? "Gagal memuat data");
    } catch (e) { if (seq === reqSeq.current) setError(String(e)); }
    if (seq === reqSeq.current) setLoading(false);
  }

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div style="padding:8px;display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;gap:6px;align-items:center">
        <input type="text" value={tahun} onInput={(e) => setTahun((e.target as HTMLInputElement).value)} placeholder="Tahun" style="width:70px;font-size:11px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)" />
        <select style="flex:1;font-size:11px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)" value={statusFilter} onChange={(e) => setStatusFilter((e.target as HTMLSelectElement).value)}>
          {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      {loading && <p class="hint">Memuat…</p>}
      {error && <p class="hint" style="color:var(--error)">{error}</p>}

      {!loading && items.map((item) => {
        const noPaket = String(item.no_paket ?? "");
        const status = String(item.status_paket ?? "");
        const isSelesai = status === "SELESAI";
        return (
          <div key={noPaket} class="card" style="padding:10px;cursor:pointer" onClick={() => onSelect(noPaket)}>
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
              <div style="flex:1;min-width:0">
                <div style="font-weight:600;font-size:13px;color:var(--color-primary)">{noPaket}</div>
                <div style="font-size:11px;color:var(--text-primary);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{String(item.ur_satker ?? "")}</div>
                <div style="font-size:10px;color:var(--muted);margin-top:2px">{String(item.jml_bmn ?? 0)} BMN</div>
              </div>
              <div style={`font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;${isSelesai ? "background:color-mix(in srgb, #16a34a 15%, transparent);color:#16a34a" : "background:var(--surface-2);color:var(--text-primary)"}`}>
                {status || "—"}
              </div>
            </div>
          </div>
        );
      })}

      {!loading && items.length === 0 && !error && <p class="hint">Tidak ada paket evaluasi.</p>}

      {totalPages > 1 && (
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
          <button class="btn btn--ghost" style="font-size:11px;padding:4px 10px;display:inline-flex;align-items:center;gap:4px" disabled={page === 0} onClick={() => fetchPage(page - 1)}><Icon name="chevron-left" size={14} /> Prev</button>
          <span class="hint">Hal {page + 1} / {totalPages} ({total} data)</span>
          <button class="btn btn--ghost" style="font-size:11px;padding:4px 10px;display:inline-flex;align-items:center;gap:4px" disabled={page >= totalPages - 1} onClick={() => fetchPage(page + 1)}>Next <Icon name="chevron-right" size={14} /></button>
        </div>
      )}
    </div>
  );
}
