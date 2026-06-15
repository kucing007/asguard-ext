/**
 * TemplateListView — Browse, run, edit, delete saved templates.
 * Shows a "Save template?" banner when a new CreateNaskahPayload was captured.
 */
import { useEffect, useState, useRef } from "preact/hooks";
import type { NaskahTemplate, KonsepFile, OrgUnit } from "@/shared/types";

interface Props {
  onEdit: (template: NaskahTemplate) => void;
  onMailMerge: (template: NaskahTemplate) => void;
  onManualInput: (template: NaskahTemplate) => void;
}

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

/** Extract a readable perihal from a template payload */
function getPerihal(payload: Record<string, unknown>): string {
  const direct = payload.Perihal as string | undefined;
  if (direct?.trim()) return direct.trim();
  const dataNd = payload.DataNd as Record<string, unknown> | undefined;
  const nested = dataNd?.Perihal as string | undefined;
  return nested?.trim() || "—";
}

function getPengirim(payload: Record<string, unknown>): string {
  const param = payload.PengirimNdParam as Record<string, unknown> | undefined;
  const pengirim = param?.Pengirim as Record<string, unknown> | undefined;
  return (pengirim?.NamaJabatan as string) || "—";
}

function getTujuanCount(payload: Record<string, unknown>): number {
  return ((payload.UnitTujuan as unknown[]) ?? []).length;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
}

// --- Save Template Modal ---

interface SaveModalProps {
  payload: Record<string, unknown>;
  onSave: () => void;
  onDismiss: () => void;
}

function SaveModal({ payload, onSave, onDismiss }: SaveModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [konsepFile, setKonsepFile] = useState<KonsepFile | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const perihal = getPerihal(payload);

  function handleFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1] ?? "";
      setKonsepFile({ name: file.name, base64, size: file.size });
    };
    reader.readAsDataURL(file);
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    await send({ type: "template/save", template: { name: name.trim(), description: description.trim(), payload, konsepFile: konsepFile ?? undefined } });
    onSave();
  }

  return (
    <div class="modal-overlay">
      <div class="modal">
        <h2 class="modal__title">💾 Simpan Template</h2>
        <p class="modal__perihal">{perihal}</p>

        <label class="field">
          <span class="field__label">Nama Template *</span>
          <input class="field__input" type="text" placeholder="cth. Undangan Rapat Rutin" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>

        <label class="field">
          <span class="field__label">Deskripsi</span>
          <input class="field__input" type="text" placeholder="opsional" value={description} onInput={(e) => setDescription((e.target as HTMLInputElement).value)} />
        </label>

        <div class="field">
          <span class="field__label">File Konsep ND (.docx)</span>
          {konsepFile ? (
            <div class="field__file-badge">
              📄 {konsepFile.name}
              <button class="btn-icon btn-icon--sm" onClick={() => setKonsepFile(null)} title="Hapus file">✕</button>
            </div>
          ) : (
            <button class="btn btn--ghost btn--sm" onClick={() => fileRef.current?.click()}>Pilih file…</button>
          )}
          <input ref={fileRef} type="file" accept=".docx,.doc" style="display:none" onChange={handleFile} />
        </div>

        <div class="modal__actions">
          <button class="btn btn--ghost" onClick={onDismiss} disabled={saving}>Nanti</button>
          <button class="btn btn--primary" onClick={handleSave} disabled={!name.trim() || saving}>
            {saving ? "Menyimpan…" : "Simpan"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Run Modal: edit perihal before submit ---

interface RunModalProps {
  template: NaskahTemplate;
  onRun: (perihalOverride: string, penandatanganUnit?: OrgUnit) => void;
  onClose: () => void;
}

function RunModal({ template, onRun, onClose }: RunModalProps) {
  const [perihal, setPerihal] = useState(getPerihal(template.payload));
  // Penandatangan picker state
  const [units, setUnits] = useState<OrgUnit[] | null>(null);
  const [loadingUnits, setLoadingUnits] = useState(false);
  const [chosenUnit, setChosenUnit] = useState<OrgUnit | null>(null);
  const [step, setStep] = useState<"perihal" | "penandatangan">("perihal");

  // Determine if NP picker is needed
  const pengirimParam = template.payload.PengirimNdParam as Record<string, unknown> | undefined;
  const pengirimData = (pengirimParam?.Pengirim ?? {}) as Record<string, unknown>;
  const eselon = pengirimData.Eselon as number | undefined;
  const needsNPPicker = eselon !== undefined && eselon <= 3 && !template.notaPengantarData?.Penandatangan;

  async function fetchUnits() {
    setLoadingUnits(true);
    try {
      const kodeOrg = (pengirimData.KodeOrganisasi ?? pengirimData.KodeUnit ?? "") as string;
      const res = await chrome.runtime.sendMessage({
        type: "template/units",
        kodeOrganisasi: kodeOrg,
        pengirimEselon: eselon,
      }) as { ok: boolean; data?: OrgUnit[]; error?: string };
      if (res.ok && res.data) setUnits(res.data);
      else setUnits([]);
    } catch { setUnits([]); }
    setLoadingUnits(false);
  }

  function goToNPStep() {
    setStep("penandatangan");
    if (!units) fetchUnits();
  }

  function handleConfirm() {
    onRun(perihal, chosenUnit ?? undefined);
  }

  // Step 1: Perihal + go-to-NP if needed
  if (step === "perihal") {
    return (
      <div class="modal-overlay">
        <div class="modal">
          <h2 class="modal__title">▶️ Jalankan Template</h2>
          <p class="modal__sub">{template.name}</p>

          <label class="field">
            <span class="field__label">Perihal</span>
            <input class="field__input" type="text" value={perihal} onInput={(e) => setPerihal((e.target as HTMLInputElement).value)} />
          </label>

          {template.konsepFile && (
            <p class="modal__hint">📄 {template.konsepFile.name} akan diupload otomatis</p>
          )}
          {eselon !== undefined && eselon <= 3 && (
            <p class="modal__hint">{template.notaPengantarData?.Penandatangan
              ? `📝 NP → ${(template.notaPengantarData.Penandatangan as OrgUnit[])[0]?.NamaJabatan ?? "tersimpan"}`
              : `📝 Nota Pengantar perlu dipilih (eselon ${eselon})`}
            </p>
          )}

          <div class="modal__actions">
            <button class="btn btn--ghost" onClick={onClose}>Batal</button>
            {needsNPPicker
              ? <button class="btn btn--primary" onClick={goToNPStep} disabled={!perihal.trim()}>Pilih Penandatangan →</button>
              : <button class="btn btn--primary" onClick={handleConfirm} disabled={!perihal.trim()}>Jalankan</button>
            }
          </div>
        </div>
      </div>
    );
  }

  // Step 2: Penandatangan picker
  return (
    <div class="modal-overlay">
      <div class="modal">
        <h2 class="modal__title">📝 Pilih Penandatangan NP</h2>
        <p class="modal__sub">Eselon {eselon} → pilih eselon {(eselon ?? 0) + 1} di bawahnya</p>

        {loadingUnits && <p class="modal__hint">Memuat daftar unit…</p>}

        {units && units.length === 0 && (
          <p class="modal__hint" style="color: var(--color-warning)">Tidak ada unit ditemukan. Jalankan tanpa NP?</p>
        )}

        {units && units.length > 0 && (
          <div class="unit-picker">
            {units.map((u, i) => (
              <button
                key={i}
                class={`unit-picker__item ${chosenUnit === u ? "unit-picker__item--active" : ""}`}
                onClick={() => setChosenUnit(u)}
              >
                <span class="unit-picker__jabatan">{u.NamaJabatan || "—"}</span>
                <span class="unit-picker__meta">{u.NamaPejabat || "—"} · Es.{u.Eselon}</span>
              </button>
            ))}
          </div>
        )}

        <div class="modal__actions">
          <button class="btn btn--ghost" onClick={() => setStep("perihal")}>← Kembali</button>
          <button class="btn btn--primary" onClick={handleConfirm}
            disabled={needsNPPicker && !!units && units.length > 0 && !chosenUnit}>
            Jalankan
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Run Progress Overlay ---

interface RunStep { step: number; total: number; label: string; }

interface RunProgressProps {
  steps: RunStep[];
  done: boolean;
  error: string | null;
  ndId: number | null;
  onClose: () => void;
}

function RunProgress({ steps, done, error, ndId, onClose }: RunProgressProps) {
  const current = steps[steps.length - 1];
  return (
    <div class="modal-overlay">
      <div class="modal">
        <h2 class="modal__title">{done ? (error ? "❌ Gagal" : "✅ Selesai") : "⏳ Menjalankan…"}</h2>

        <div class="run-progress">
          {steps.map((s, i) => (
            <div key={i} class={`run-step ${i === steps.length - 1 && !done ? "run-step--active" : "run-step--done"}`}>
              <span class="run-step__icon">{i === steps.length - 1 && !done ? "⏳" : "✓"}</span>
              <span>{s.label}</span>
            </div>
          ))}
        </div>

        {!done && current && (
          <p class="run-progress__sub">Langkah {current.step}/{current.total}</p>
        )}
        {done && !error && ndId && (
          <p class="run-progress__success">Naskah berhasil dibuat (ID: {ndId})</p>
        )}
        {error && <p class="run-progress__error">{error}</p>}

        {done && (
          <div class="modal__actions">
            <button class="btn btn--primary" onClick={onClose}>Tutup</button>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Delete confirmation inline ---

// --- Main view ---

export function TemplateListView({ onEdit, onMailMerge, onManualInput }: Props) {
  const [templates, setTemplates] = useState<NaskahTemplate[]>([]);
  const [pendingPayload, setPendingPayload] = useState<Record<string, unknown> | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [runTarget, setRunTarget] = useState<NaskahTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const [runDone, setRunDone] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runNdId, setRunNdId] = useState<number | null>(null);
  const [showRunProgress, setShowRunProgress] = useState(false);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  async function loadTemplates() {
    const res = await send<{ ok: boolean; data: NaskahTemplate[] }>({ type: "template/list" });
    if (res.ok) setTemplates(res.data);
  }

  async function loadPending() {
    const res = await send<{ ok: boolean; data: Record<string, unknown> | null }>({ type: "template/pending" });
    if (res.ok && res.data) {
      setPendingPayload(res.data);
      setShowSaveModal(true);
    }
  }

  useEffect(() => {
    loadTemplates();
    loadPending();

    const onMsg = (msg: { type?: string; snapshot?: { pendingPayload?: boolean } }) => {
      if (msg?.type === "state/changed" && msg.snapshot?.pendingPayload) {
        loadPending();
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  async function handleDelete(id: string) {
    await send({ type: "template/delete", id });
    setDeleteTarget(null);
    loadTemplates();
  }

  function handleRun(template: NaskahTemplate) {
    setRunTarget(template);
  }

  function startRun(perihalOverride: string, penandatanganUnit?: OrgUnit) {
    if (!runTarget) return;
    setRunTarget(null);
    setRunSteps([]);
    setRunDone(false);
    setRunError(null);
    setRunNdId(null);
    setShowRunProgress(true);

    const port = chrome.runtime.connect({ name: "template-run" });
    portRef.current = port;

    port.onMessage.addListener((msg: { type: string; step?: number; total?: number; label?: string; ndId?: number; error?: string }) => {
      if (msg.type === "run/step") {
        setRunSteps((prev) => [...prev, { step: msg.step!, total: msg.total!, label: msg.label! }]);
      } else if (msg.type === "run/done") {
        setRunSteps((prev) => [...prev]);
        setRunNdId(msg.ndId ?? null);
        setRunDone(true);
        port.disconnect();
        loadTemplates(); // refresh in case notaPengantarData was saved
      } else if (msg.type === "run/error") {
        setRunError(msg.error ?? "Error tidak diketahui");
        setRunDone(true);
        port.disconnect();
      }
    });

    port.postMessage({ type: "template/run", templateId: runTarget.id, perihalOverride, penandatanganUnit });
  }


  return (
    <div class="view-template fade-in">
      {/* Pending payload banner */}
      {pendingPayload && !showSaveModal && (
        <div class="template-banner">
          <div class="template-banner__text">
            <span class="template-banner__icon">📋</span>
            <span>Naskah baru terdeteksi — simpan sebagai template?</span>
          </div>
          <button class="btn btn--primary btn--sm" onClick={() => setShowSaveModal(true)}>Simpan</button>
        </div>
      )}

      {templates.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__icon">📋</div>
          <p class="empty-state__title">Belum ada template</p>
          <p class="empty-state__sub">Buat naskah di Nadine, lalu simpan sebagai template untuk digunakan kembali.</p>
        </div>
      ) : (
        <div class="template-list">
          {templates.map((t) => {
            const perihal = getPerihal(t.payload);
            const pengirim = getPengirim(t.payload);
            const tujuanCount = getTujuanCount(t.payload);
            const isDeletingThis = deleteTarget === t.id;

            return (
              <div key={t.id} class="template-card">
                <div class="template-card__header">
                  <span class="template-card__name">{t.name}</span>
                  <span class="template-card__date">{formatDate(t.createdAt)}</span>
                </div>
                <p class="template-card__perihal">{perihal.length > 80 ? perihal.slice(0, 77) + "…" : perihal}</p>
                <div class="template-card__meta">
                  <span>👤 {pengirim.length > 35 ? pengirim.slice(0, 32) + "…" : pengirim}</span>
                  <span>📬 {tujuanCount} tujuan</span>
                  {t.konsepFile && <span>📄 {t.konsepFile.name}</span>}
                </div>

                {isDeletingThis ? (
                  <div class="template-card__confirm">
                    <span>Hapus template ini?</span>
                    <button class="btn btn--danger btn--sm" onClick={() => handleDelete(t.id)}>Hapus</button>
                    <button class="btn btn--ghost btn--sm" onClick={() => setDeleteTarget(null)}>Batal</button>
                  </div>
                ) : (
                  <div class="template-card__actions">
                    <button class="btn btn--primary btn--sm" onClick={() => handleRun(t)}>▶ Jalankan</button>
                    {t.konsepFile && (
                      <button class="btn btn--ghost btn--sm" onClick={() => onManualInput(t)} title="Input manual placeholder">✏️ Manual</button>
                    )}
                    {t.konsepFile && (
                      <button class="btn btn--ghost btn--sm" onClick={() => onMailMerge(t)} title="Batch mail merge dari Excel">📊 Batch</button>
                    )}
                    <button class="btn btn--ghost btn--sm" onClick={() => onEdit(t)}>✏ Edit</button>
                    <button class="btn btn--ghost btn--sm btn--danger-ghost" onClick={() => setDeleteTarget(t.id)}>🗑</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {showSaveModal && pendingPayload && (
        <SaveModal
          payload={pendingPayload}
          onSave={() => { setShowSaveModal(false); setPendingPayload(null); loadTemplates(); }}
          onDismiss={() => setShowSaveModal(false)}
        />
      )}

      {runTarget && (
        <RunModal
          template={runTarget}
          onRun={startRun}
          onClose={() => setRunTarget(null)}
        />
      )}

      {showRunProgress && (
        <RunProgress
          steps={runSteps}
          done={runDone}
          error={runError}
          ndId={runNdId}
          onClose={() => { setShowRunProgress(false); setRunSteps([]); }}
        />
      )}
    </div>
  );
}
