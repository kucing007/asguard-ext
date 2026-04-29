/**
 * TemplateDetailView — View and edit a single saved template.
 * Supports editing name, description, perihal, and uploading replacement konsep files.
 */
import { useEffect, useState, useRef } from "preact/hooks";
import type { NaskahTemplate, KonsepFile } from "@/shared/types";

interface Props {
  templateId: string;
  onBack: () => void;
  onMailMerge?: (id: string) => void;
}

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function getPerihal(payload: Record<string, unknown>): string {
  const direct = payload.Perihal as string | undefined;
  if (direct?.trim()) return direct.trim();
  const dataNd = payload.DataNd as Record<string, unknown> | undefined;
  return (dataNd?.Perihal as string | undefined)?.trim() || "—";
}

export function TemplateDetailView({ templateId, onBack, onMailMerge }: Props) {
  const [template, setTemplate] = useState<NaskahTemplate | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [perihal, setPerihal] = useState("");
  const [konsepFile, setKonsepFile] = useState<KonsepFile | undefined>();
  const [konsepNotaFile, setKonsepNotaFile] = useState<KonsepFile | undefined>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const ndFileRef = useRef<HTMLInputElement>(null);
  const npFileRef = useRef<HTMLInputElement>(null);

  async function loadTemplate() {
    const res = await send<{ ok: boolean; data: NaskahTemplate }>({ type: "template/get", id: templateId });
    if (res.ok) {
      const t = res.data;
      setTemplate(t);
      setName(t.name);
      setDescription(t.description);
      setPerihal(getPerihal(t.payload));
      setKonsepFile(t.konsepFile);
      setKonsepNotaFile(t.konsepNotaFile);
    }
  }

  useEffect(() => { loadTemplate(); }, [templateId]);

  function handleFile(e: Event, setter: (f: KonsepFile) => void) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1] ?? "";
      setter({ name: file.name, base64, size: file.size });
    };
    reader.readAsDataURL(file);
  }

  async function handleSave() {
    if (!template) return;
    setSaving(true);
    setSaved(false);

    const updatedPayload = { ...template.payload, Perihal: perihal };

    await send({
      type: "template/update",
      id: template.id,
      updates: {
        name: name.trim(),
        description: description.trim(),
        payload: updatedPayload,
        konsepFile,
        konsepNotaFile,
      },
    });

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    loadTemplate();
  }

  if (!template) {
    return (
      <div class="view-template fade-in">
        <p class="hint">Memuat template…</p>
      </div>
    );
  }

  const payload = template.payload;
  const pengirimParam = payload.PengirimNdParam as Record<string, unknown> | undefined;
  const pengirim = (pengirimParam?.Pengirim ?? {}) as Record<string, unknown>;
  const tujuan = (payload.UnitTujuan as Array<Record<string, unknown>>) ?? [];
  const tembusan = (payload.UnitTembusan as Array<Record<string, unknown>>) ?? [];
  const templateId_ = payload.TemplateId;
  const sifatNdId = payload.SifatNdId;

  return (
    <div class="view-template fade-in">
      <button class="btn btn--ghost btn--sm back-btn" onClick={onBack}>← Kembali</button>

      <h2 class="section-title">Edit Template</h2>

      <div class="field">
        <span class="field__label">Nama Template</span>
        <input class="field__input" type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </div>
      <div class="field">
        <span class="field__label">Deskripsi</span>
        <input class="field__input" type="text" value={description} onInput={(e) => setDescription((e.target as HTMLInputElement).value)} />
      </div>
      <div class="field">
        <span class="field__label">Perihal</span>
        <input class="field__input" type="text" value={perihal} onInput={(e) => setPerihal((e.target as HTMLInputElement).value)} />
      </div>

      <div class="detail-section">
        <h3 class="detail-section__title">Info Naskah</h3>
        <div class="detail-row"><span class="detail-row__label">Template ID</span><span>{String(templateId_ ?? "—")}</span></div>
        <div class="detail-row"><span class="detail-row__label">Pengirim</span><span>{(pengirim.NamaJabatan as string) || "—"}</span></div>
        <div class="detail-row"><span class="detail-row__label">Pejabat</span><span>{(pengirim.NamaPejabat as string) || "—"}</span></div>
        <div class="detail-row"><span class="detail-row__label">Eselon</span><span>{String(pengirim.Eselon ?? "—")}</span></div>
        <div class="detail-row"><span class="detail-row__label">Sifat ND</span><span>{String(sifatNdId ?? "—")}</span></div>
      </div>

      {tujuan.length > 0 && (
        <div class="detail-section">
          <h3 class="detail-section__title">Tujuan ({tujuan.length})</h3>
          {tujuan.slice(0, 5).map((u, i) => (
            <div key={i} class="detail-row detail-row--compact">• {(u.NamaJabatan as string) || (u.NamaOrganisasi as string) || "—"}</div>
          ))}
          {tujuan.length > 5 && <div class="detail-row detail-row--muted">…dan {tujuan.length - 5} lainnya</div>}
        </div>
      )}

      {tembusan.length > 0 && (
        <div class="detail-section">
          <h3 class="detail-section__title">Tembusan ({tembusan.length})</h3>
          {tembusan.slice(0, 3).map((u, i) => (
            <div key={i} class="detail-row detail-row--compact">• {(u.NamaJabatan as string) || (u.NamaOrganisasi as string) || "—"}</div>
          ))}
        </div>
      )}

      <div class="detail-section">
        <h3 class="detail-section__title">File Konsep</h3>
        <div class="field">
          <span class="field__label">File ND (.docx)</span>
          {konsepFile ? (
            <div class="field__file-badge">
              📄 {konsepFile.name} <span class="field__file-size">({Math.round(konsepFile.size / 1024)}KB)</span>
              <button class="btn-icon btn-icon--sm" onClick={() => setKonsepFile(undefined)}>✕</button>
            </div>
          ) : (
            <button class="btn btn--ghost btn--sm" onClick={() => ndFileRef.current?.click()}>Pilih file…</button>
          )}
          <input ref={ndFileRef} type="file" accept=".docx,.doc" style="display:none" onChange={(e) => handleFile(e, setKonsepFile)} />
        </div>
        <div class="field">
          <span class="field__label">File Nota Pengantar (.docx)</span>
          {konsepNotaFile ? (
            <div class="field__file-badge">
              📄 {konsepNotaFile.name} <span class="field__file-size">({Math.round(konsepNotaFile.size / 1024)}KB)</span>
              <button class="btn-icon btn-icon--sm" onClick={() => setKonsepNotaFile(undefined)}>✕</button>
            </div>
          ) : (
            <button class="btn btn--ghost btn--sm" onClick={() => npFileRef.current?.click()}>Pilih file…</button>
          )}
          <input ref={npFileRef} type="file" accept=".docx,.doc" style="display:none" onChange={(e) => handleFile(e, setKonsepNotaFile)} />
        </div>
      </div>

      <div class="detail-actions">
        <button class="btn btn--primary" onClick={handleSave} disabled={saving}>
          {saving ? "Menyimpan…" : saved ? "✓ Tersimpan" : "Simpan Perubahan"}
        </button>
        {konsepFile && onMailMerge && (
          <button class="btn btn--ghost" onClick={() => onMailMerge(templateId)} title="Batch mail merge dari Excel">
            📊 Mail Merge
          </button>
        )}
      </div>
    </div>
  );
}
