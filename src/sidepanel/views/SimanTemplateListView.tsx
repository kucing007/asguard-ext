import { useState, useEffect } from "preact/hooks";
import type { PanelSnapshot, SimanTemplate } from "@/shared/types";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

interface Props {
  snap: PanelSnapshot;
  onEdit: (id: string) => void;
  onBack: () => void;
}

export function SimanTemplateListView({ onEdit }: Props) {
  const [templates, setTemplates] = useState<SimanTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const r = await send<{ ok: boolean; data?: SimanTemplate[] }>({ type: "siman/get-templates" });
    if (r.ok) setTemplates(r.data ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function del(id: string) {
    await send({ type: "siman/delete-template", id });
    setDeleteId(null);
    await load();
  }

  if (loading) return <p class="hint" style="padding:12px">Memuat…</p>;

  return (
    <div style="padding:12px">
      <button class="btn" style="width:100%;margin-bottom:12px" onClick={() => onEdit("new")}>
        + Template Baru
      </button>
      {templates.length === 0 && <p class="hint">Belum ada template. Buat template baru untuk memulai.</p>}
      {templates.map((t) => (
        <div key={t.id} class="card" style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div>
              <div style="font-weight:600;font-size:13px">{t.name}</div>
              <div class="hint" style="margin-top:2px">{t.namaTipe} · {Object.keys(t.mapping).length} variabel</div>
              <div class="hint" style="margin-top:2px">
                {t.konsepNd ? "ND ✓" : "ND —"} · {t.konsepNp ? "NP ✓" : "NP —"}
              </div>
            </div>
            <div style="display:flex;gap:6px">
              {deleteId === t.id ? (
                <>
                  <button class="btn btn--ghost" style="font-size:11px;padding:4px 8px" onClick={() => setDeleteId(null)}>Batal</button>
                  <button class="btn" style="font-size:11px;padding:4px 8px;background:var(--error);color:#fff;border:none" onClick={() => del(t.id)}>Hapus</button>
                </>
              ) : (
                <>
                  <button class="btn btn--ghost" style="font-size:11px;padding:4px 8px" onClick={() => onEdit(t.id)}>Edit</button>
                  <button class="btn btn--ghost" style="font-size:11px;padding:4px 8px;color:var(--error)" onClick={() => setDeleteId(t.id)}>Hapus</button>
                </>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
