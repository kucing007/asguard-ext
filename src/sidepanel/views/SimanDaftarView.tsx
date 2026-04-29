import { useState, useEffect, useRef } from "preact/hooks";
import type { PanelSnapshot, SimanTemplate, SimanPenetapan, SimanTipePengelolaan } from "@/shared/types";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

const STATUS_OPTIONS = [
  { label: "Semua status", value: "" },
  { label: "Proses", value: "penelitian" },
  { label: "Selesai", value: "selesai" },
  { label: "Draft", value: "draft" },
];
const LIMIT = 10;

interface Props {
  snap: PanelSnapshot;
  onRun: (noTiket: string, idPengelolaan: string, idTipePengelolaan: string, templateId: string) => void;
  onBack: () => void;
}

export function SimanDaftarView({ onRun }: Props) {
  const [items, setItems] = useState<SimanPenetapan[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [idTipeFilter, setIdTipeFilter] = useState("");
  const [tipes, setTipes] = useState<SimanTipePengelolaan[]>([]);
  const [templates, setTemplates] = useState<SimanTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqSeq = useRef(0);

  useEffect(() => {
    send<{ ok: boolean; data?: SimanTipePengelolaan[] }>({ type: "siman/get-tipe-pengelolaan" })
      .then((r) => { if (r.ok) setTipes(r.data ?? []); });
    send<{ ok: boolean; data?: SimanTemplate[] }>({ type: "siman/get-templates" })
      .then((r) => { if (r.ok) setTemplates(r.data ?? []); });
  }, []);

  useEffect(() => { fetchPage(0); }, [statusFilter, idTipeFilter]);

  async function fetchPage(p: number) {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await send<{ ok: boolean; data?: { data: SimanPenetapan[]; total: number }; error?: string }>({
        type: "siman/get-penetapan-list",
        limit: LIMIT,
        offset: p * LIMIT,
        statusFilter: statusFilter || undefined,
        idTipe: idTipeFilter || undefined,
      });
      if (seq !== reqSeq.current) return;
      if (r.ok && r.data) {
        setItems(r.data.data);
        setTotal(r.data.total);
        setPage(p);
      } else {
        setError(r.error ?? "Gagal memuat data");
      }
    } catch (e) {
      if (seq === reqSeq.current) setError(String(e));
    }
    if (seq === reqSeq.current) setLoading(false);
  }

  function templatesForItem(item: SimanPenetapan) {
    return templates.filter((t) => String(t.idTipePengelolaan) === item.idTipePengelolaan);
  }

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div style="padding:8px;display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;gap:6px">
        <select
          style="flex:1;font-size:11px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
          value={statusFilter}
          onChange={(e) => setStatusFilter((e.target as HTMLSelectElement).value)}
        >
          {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select
          style="flex:1;font-size:11px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
          value={idTipeFilter}
          onChange={(e) => setIdTipeFilter((e.target as HTMLSelectElement).value)}
        >
          <option value="">Semua tipe</option>
          {tipes.map((t) => <option key={t.id} value={t.id}>{t.nama}</option>)}
        </select>
      </div>

      {loading && <p class="hint">Memuat…</p>}
      {error && <p class="hint" style="color:var(--error)">{error}</p>}

      {!loading && items.map((item) => (
        <PenetapanCard
          key={item.noTiket}
          item={item}
          templates={templatesForItem(item)}
          onRun={onRun}
        />
      ))}

      {!loading && items.length === 0 && !error && (
        <p class="hint">Tidak ada data pengelolaan.</p>
      )}

      {totalPages > 1 && (
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
          <button class="btn btn--ghost" style="font-size:11px;padding:4px 10px" disabled={page === 0} onClick={() => fetchPage(page - 1)}>◀ Prev</button>
          <span class="hint">Hal {page + 1} / {totalPages} ({total} data)</span>
          <button class="btn btn--ghost" style="font-size:11px;padding:4px 10px" disabled={page >= totalPages - 1} onClick={() => fetchPage(page + 1)}>Next ▶</button>
        </div>
      )}
    </div>
  );
}

function PenetapanCard({ item, templates, onRun }: {
  item: SimanPenetapan;
  templates: SimanTemplate[];
  onRun: (noTiket: string, idPengelolaan: string, idTipePengelolaan: string, templateId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(templates[0]?.id ?? "");

  useEffect(() => { setSelectedTemplate(templates[0]?.id ?? ""); }, [templates]);

  return (
    <div class="card" style="padding:10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:12px;color:var(--color-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{item.noTiket}</div>
          <div style="font-size:11px;color:var(--text-primary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{item.satker}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:1px">{item.tipe}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;margin-left:8px">
          <div style="font-size:10px;padding:2px 6px;border-radius:10px;background:var(--surface-2);color:var(--text-primary);font-weight:600">
            {item.status}
          </div>
          {item.durasi && <div class="hint" style="margin-top:3px">{item.durasi}</div>}
        </div>
      </div>

      <div style="display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--line)">
        {templates.length > 0 ? (
          <>
            <select
              style="flex:1;font-size:11px;padding:3px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate((e.target as HTMLSelectElement).value)}
            >
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button
              class="btn"
              style="flex-shrink:0;font-size:11px;padding:4px 10px"
              onClick={() => onRun(item.noTiket, item.idPengelolaan, item.idTipePengelolaan, selectedTemplate)}
            >
              Buat
            </button>
          </>
        ) : (
          <span class="hint" style="font-size:10px">Buat template {item.tipe} terlebih dahulu</span>
        )}
        <button class="btn btn--ghost" style="font-size:11px;padding:4px 8px;flex-shrink:0" onClick={() => setExpanded(!expanded)}>
          {expanded ? "▲" : "▼"}
        </button>
      </div>

      {expanded && (
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line);font-size:11px;color:var(--muted)">
          <div><strong>No. Tiket:</strong> {item.noTiket}</div>
          <div><strong>Satker:</strong> {item.satker}</div>
          <div><strong>Status:</strong> {item.status}</div>
        </div>
      )}
    </div>
  );
}
