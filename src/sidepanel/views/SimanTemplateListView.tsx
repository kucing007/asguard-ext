import { useState, useEffect } from "preact/hooks";
import type { PanelSnapshot, SimanTemplate } from "@/shared/types";
import { Icon } from "../components/Icon";

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
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"date" | "name">("date");

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

  if (loading) {
    return (
      <div style="padding:12px">
        <div class="skeleton">
          <div class="skeleton__line skeleton__line--long" />
          <div class="skeleton__line skeleton__line--medium" />
          <div class="skeleton__line skeleton__line--short" />
        </div>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const visible = [...(q
    ? templates.filter((t) => t.name.toLowerCase().includes(q) || (t.namaTipe ?? "").toLowerCase().includes(q))
    : templates)
  ].sort((a, b) => {
    if (sortBy === "name") return a.name.localeCompare(b.name);
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });

  return (
    <div class="view-template" style="padding:12px;display:flex;flex-direction:column;gap:10px">
      <button class="btn btn--primary" onClick={() => onEdit("new")}><Icon name="plus" size={14} /> Template Baru</button>

      {templates.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__icon"><Icon name="clipboard-list" size={32} /></div>
          <p class="empty-state__title">Belum ada template</p>
          <p class="empty-state__sub">Buat template pengelolaan baru untuk memulai.</p>
        </div>
      ) : (
        <>
          <div class="arsip-list-bar">
            <input class="mm-search" type="text" placeholder="Cari template (nama, tipe)…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
            <select class="mm-select" style="width:auto" value={sortBy} onChange={(e) => setSortBy((e.target as HTMLSelectElement).value as "date" | "name")}>
              <option value="date">Terbaru</option>
              <option value="name">Nama (A-Z)</option>
            </select>
          </div>

          {visible.length === 0 ? (
            <p class="hint" style="padding:var(--sp-2)">Tidak ada template yang cocok.</p>
          ) : (
            visible.map((t) => (
              <div key={t.id} class="card" style="padding:10px">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
                  <div style="flex:1;min-width:0">
                    <div style="font-weight:600;font-size:13px">{t.name}</div>
                    <div class="hint" style="margin-top:2px">{t.namaTipe} · {Object.keys(t.mapping).length} variabel</div>
                    <div class="hint" style="margin-top:2px;display:flex;gap:8px">
                      <span>{t.konsepNd ? <><Icon name="check" size={11} /> ND</> : "ND —"}</span>
                      <span>{t.konsepNp ? <><Icon name="check" size={11} /> NP</> : "NP —"}</span>
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
                        <button class="btn btn--ghost" style="font-size:11px;padding:4px 8px;color:var(--error)" onClick={() => setDeleteId(t.id)} title="Hapus template" aria-label="Hapus template"><Icon name="trash" size={13} /></button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
