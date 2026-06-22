/**
 * TemplateDetailView — View and edit a single saved template.
 * Supports editing name, description, perihal, uploading replacement konsep files,
 * and configuring placeholder types (text, number, date, currency, terbilang).
 */
import { useEffect, useState, useRef } from "preact/hooks";
import type { NaskahTemplate, KonsepFile, PlaceholderConfig, PlaceholderType } from "@/shared/types";
import { scanPlaceholders } from "../mailmerge/placeholder-scan";
import { placeholderTypeLabel, DATE_FORMATS, formatPlaceholderValue } from "../mailmerge/format-value";
import { Icon } from "../components/Icon";

interface Props {
  templateId: string;
  onBack: () => void;
  onMailMerge?: (id: string) => void;
  onManualInput?: (id: string) => void;
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

const PH_TYPES: PlaceholderType[] = ["text", "number", "date", "currency", "terbilang"];

export function TemplateDetailView({ templateId, onBack, onMailMerge, onManualInput }: Props) {
  const [template, setTemplate] = useState<NaskahTemplate | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [perihal, setPerihal] = useState("");
  const [konsepFile, setKonsepFile] = useState<KonsepFile | null>(null);
  const [konsepNotaFile, setKonsepNotaFile] = useState<KonsepFile | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const ndFileRef = useRef<HTMLInputElement>(null);
  const npFileRef = useRef<HTMLInputElement>(null);

  // Placeholder config
  const [detectedPh, setDetectedPh] = useState<string[]>([]);
  const [phConfigs, setPhConfigs] = useState<PlaceholderConfig[]>([]);

  async function loadTemplate() {
    const res = await send<{ ok: boolean; data: NaskahTemplate }>({ type: "template/get", id: templateId });
    if (res.ok) {
      const t = res.data;
      setTemplate(t);
      setName(t.name);
      setDescription(t.description);
      setPerihal(getPerihal(t.payload));
      setKonsepFile(t.konsepFile ?? null);
      setKonsepNotaFile(t.konsepNotaFile ?? null);

      // Scan placeholders
      const ndPh = t.konsepFile ? scanPlaceholders(t.konsepFile.base64) : [];
      const npPh = t.konsepNotaFile ? scanPlaceholders(t.konsepNotaFile.base64) : [];
      const all = [...new Set([...ndPh, ...npPh])].sort();
      setDetectedPh(all);

      // Merge with existing configs
      const existingConfigs = t.placeholderConfigs ?? [];
      const merged: PlaceholderConfig[] = all.map((name) => {
        const existing = existingConfigs.find((c) => c.name === name);
        return existing ?? { name, type: "text" as PlaceholderType };
      });
      setPhConfigs(merged);
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

  function updatePhConfig(index: number, updates: Partial<PlaceholderConfig>) {
    setPhConfigs((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...updates };
      return next;
    });
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
        konsepFile: konsepFile as KonsepFile | undefined,
        konsepNotaFile: konsepNotaFile as KonsepFile | undefined,
        placeholderConfigs: phConfigs,
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
              <Icon name="file-text" /> {konsepFile.name} <span class="field__file-size">({Math.round(konsepFile.size / 1024)}KB)</span>
              <button class="btn-icon btn-icon--sm" onClick={() => setKonsepFile(null)}><Icon name="x" /></button>
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
              <Icon name="file-text" /> {konsepNotaFile.name} <span class="field__file-size">({Math.round(konsepNotaFile.size / 1024)}KB)</span>
              <button class="btn-icon btn-icon--sm" onClick={() => setKonsepNotaFile(null)}><Icon name="x" /></button>
            </div>
          ) : (
            <button class="btn btn--ghost btn--sm" onClick={() => npFileRef.current?.click()}>Pilih file…</button>
          )}
          <input ref={npFileRef} type="file" accept=".docx,.doc" style="display:none" onChange={(e) => handleFile(e, setKonsepNotaFile)} />
        </div>
      </div>

      {/* Placeholder Configuration */}
      {detectedPh.length > 0 && (
        <div class="detail-section">
          <h3 class="detail-section__title"><Icon name="settings" /> Konfigurasi Placeholder ({detectedPh.length})</h3>
          <p class="hint" style="margin-bottom: var(--sp-2)">Atur tipe data setiap placeholder untuk input manual dan format output.</p>

          <div class="ph-config">
            {phConfigs.map((cfg, i) => (
              <div key={cfg.name} class="ph-config__row">
                <div class="ph-config__header">
                  <code class="mm-ph">{`{${cfg.name}}`}</code>
                  <select
                    class="ph-config__type-select"
                    value={cfg.type}
                    onChange={(e) => updatePhConfig(i, { type: (e.target as HTMLSelectElement).value as PlaceholderType })}
                  >
                    {PH_TYPES.map((t) => (
                      <option key={t} value={t}>{placeholderTypeLabel(t)}</option>
                    ))}
                  </select>
                </div>

                <div class="ph-config__options">
                  <input
                    class="ph-config__input"
                    type="text"
                    placeholder="Label tampilan (opsional)"
                    value={cfg.label ?? ""}
                    onInput={(e) => updatePhConfig(i, { label: (e.target as HTMLInputElement).value || undefined })}
                  />
                  <input
                    class="ph-config__input"
                    type="text"
                    placeholder="Nilai default (opsional)"
                    value={cfg.defaultValue ?? ""}
                    onInput={(e) => updatePhConfig(i, { defaultValue: (e.target as HTMLInputElement).value || undefined })}
                  />
                  {cfg.type === "date" && (
                    <select
                      class="ph-config__input"
                      value={cfg.dateFormat ?? "DD MMMM YYYY"}
                      onChange={(e) => updatePhConfig(i, { dateFormat: (e.target as HTMLSelectElement).value })}
                    >
                      {DATE_FORMATS.map((f) => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Preview */}
                {cfg.defaultValue && cfg.type !== "text" && (
                  <span class="ph-config__preview">
                    Preview: {formatPlaceholderValue(cfg.defaultValue, cfg.type, cfg.dateFormat)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div class="detail-actions">
        <button class="btn btn--primary" onClick={handleSave} disabled={saving}>
          {saving ? "Menyimpan…" : saved ? <><Icon name="check" /> Tersimpan</> : "Simpan Perubahan"}
        </button>
        {konsepFile && onManualInput && (
          <button class="btn btn--ghost" onClick={() => onManualInput(templateId)} title="Input manual placeholder">
            <Icon name="pencil" /> Input Manual
          </button>
        )}
        {konsepFile && onMailMerge && (
          <button class="btn btn--ghost" onClick={() => onMailMerge(templateId)} title="Batch mail merge dari Excel">
            <Icon name="bar-chart" /> Mail Merge
          </button>
        )}
      </div>
    </div>
  );
}
