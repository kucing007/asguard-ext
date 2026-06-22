import { useEffect, useState } from "preact/hooks";
import type { ApiResult, LlmSettings, NotificationSettings } from "@/shared/types";
import { DEFAULT_LLM_SETTINGS, DEFAULT_NOTIFICATION_SETTINGS } from "@/shared/types";
import { SUMMARY_SYSTEM_PROMPT } from "@/shared/prompts";
import { Icon } from "../components/Icon";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

interface SettingsViewProps {
  onBack: () => void;
}

export function SettingsView({ onBack }: SettingsViewProps) {
  const [settings, setSettings] = useState<LlmSettings>({ ...DEFAULT_LLM_SETTINGS });
  const [healthStatus, setHealthStatus] = useState<"idle" | "checking" | "ok" | "fail">("idle");
  const [saved, setSaved] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);

  useEffect(() => {
    send<ApiResult<LlmSettings>>({ type: "settings/get" }).then((res) => {
      if (res.ok) setSettings(res.data);
    });
  }, []);

  async function handleSave() {
    await send({ type: "settings/set", settings });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleTestConnection() {
    setHealthStatus("checking");
    const res = await send<ApiResult<boolean>>({ type: "llm/health" });
    setHealthStatus(res.ok && res.data ? "ok" : "fail");
    setTimeout(() => setHealthStatus("idle"), 3000);
  }

  async function handleClearCache() {
    await send({ type: "cache/clear" });
    setCacheCleared(true);
    setTimeout(() => setCacheCleared(false), 2000);
  }

  return (
    <div class="settings-view fade-in">
      <button class="btn btn--ghost" onClick={onBack}>
        <Icon name="chevron-left" /> Kembali
      </button>

      <section class="card">
        <h2 class="card__title">Pengaturan LLM</h2>

        <label class="field">
          <span class="field__label">URL llama.cpp</span>
          <input
            class="input"
            type="text"
            value={settings.llamaUrl}
            onInput={(e) =>
              setSettings({ ...settings, llamaUrl: (e.target as HTMLInputElement).value })
            }
          />
        </label>

        <label class="field">
          <span class="field__label">Nama Model</span>
          <input
            class="input"
            type="text"
            value={settings.modelName}
            onInput={(e) =>
              setSettings({ ...settings, modelName: (e.target as HTMLInputElement).value })
            }
          />
        </label>

        <label class="field">
          <span class="field__label">Max Tokens (output)</span>
          <input
            class="input"
            type="number"
            min={128}
            max={8192}
            value={settings.maxTokens}
            onInput={(e) =>
              setSettings({
                ...settings,
                maxTokens: parseInt((e.target as HTMLInputElement).value, 10) || 512,
              })
            }
          />
          <span class="field__hint">Token output AI. Lebih kecil = lebih cepat.</span>
        </label>

        <label class="field">
          <span class="field__label">Temperatur</span>
          <input
            class="input"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={settings.temperature ?? 0.2}
            onInput={(e) =>
              setSettings({
                ...settings,
                temperature: parseFloat((e.target as HTMLInputElement).value) || 0.2,
              })
            }
          />
          <span class="field__hint">Lebih rendah = lebih cepat & konsisten. Default: 0.2</span>
        </label>

        <label class="field">
          <span class="field__label">Maks Halaman PDF</span>
          <input
            class="input"
            type="number"
            min={0}
            max={50}
            step={1}
            value={settings.maxPages ?? 7}
            onInput={(e) =>
              setSettings({
                ...settings,
                maxPages: parseInt((e.target as HTMLInputElement).value, 10) || 7,
              })
            }
          />
          <span class="field__hint">Halaman pertama yang dibaca AI. 0 = semua halaman.</span>
        </label>

        <label class="field">
          <span class="field__label">Batas Teks Input</span>
          <input
            class="input"
            type="number"
            min={0}
            max={20000}
            step={500}
            value={settings.maxInputChars ?? 4000}
            onInput={(e) =>
              setSettings({
                ...settings,
                maxInputChars: parseInt((e.target as HTMLInputElement).value, 10),
              })
            }
          />
          <span class="field__hint">Karakter maks dikirim ke AI. 0 = tanpa batas.</span>
        </label>

        <label class="field">
          <span class="field__label">System Prompt (kosongkan untuk default)</span>
          <textarea
            class="textarea"
            rows={5}
            placeholder={SUMMARY_SYSTEM_PROMPT.slice(0, 200) + "…"}
            value={settings.systemPrompt}
            onInput={(e) =>
              setSettings({ ...settings, systemPrompt: (e.target as HTMLTextAreaElement).value })
            }
          />
        </label>

        <div class="settings-actions">
          <button class="btn" onClick={handleSave}>
            {saved ? <><Icon name="circle-check" /> Tersimpan</> : "Simpan"}
          </button>
          <button class="btn btn--secondary" onClick={handleTestConnection}>
            {healthStatus === "checking"
              ? "Menguji…"
              : healthStatus === "ok"
                ? <><Icon name="circle-check" /> Terhubung</>
                : healthStatus === "fail"
                  ? <><Icon name="circle-x" /> Gagal</>
                  : "Test Koneksi"}
          </button>
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">Cache</h2>
        <p class="hint">Ringkasan yang sudah dibuat disimpan secara lokal.</p>
        <button class="btn btn--secondary" onClick={handleClearCache}>
          {cacheCleared ? <><Icon name="circle-check" /> Terhapus</> : "Hapus Cache Ringkasan"}
        </button>
      </section>

      <NotificationSection />

      <BackupSection />
    </div>
  );
}

function NotificationSection() {
  const [settings, setSettings] = useState<NotificationSettings>({ ...DEFAULT_NOTIFICATION_SETTINGS });

  useEffect(() => {
    send<ApiResult<NotificationSettings>>({ type: "notif/settings/get" }).then((res) => {
      if (res.ok) setSettings(res.data);
    });
  }, []);

  async function update(partial: Partial<NotificationSettings>) {
    const next = { ...settings, ...partial };
    setSettings(next);
    await send({ type: "notif/settings/set", settings: partial });
  }

  return (
    <section class="card">
      <h2 class="card__title">Notifikasi</h2>
      <p class="hint">
        Memeriksa setiap 1 menit. Notifikasi hanya muncul untuk item baru sejak terakhir dicek.
      </p>
      <label class="field" style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input
          type="checkbox"
          checked={settings.disposisi}
          onChange={(e) => update({ disposisi: (e.target as HTMLInputElement).checked })}
        />
        <span>Disposisi baru</span>
      </label>
      <label class="field" style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input
          type="checkbox"
          checked={settings.amplop}
          onChange={(e) => update({ amplop: (e.target as HTMLInputElement).checked })}
        />
        <span>Amplop baru</span>
      </label>
      <label class="field" style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input
          type="checkbox"
          checked={settings.siman}
          onChange={(e) => update({ siman: (e.target as HTMLInputElement).checked })}
        />
        <span>Tiket SIMAN baru</span>
      </label>
    </section>
  );
}

function BackupSection() {
  const [exporting, setExporting] = useState(false);
  const [importStatus, setImportStatus] = useState<"idle" | "done" | "error">("idle");
  const [importMsg, setImportMsg] = useState("");

  async function handleExport() {
    setExporting(true);
    try {
      const res = await (chrome.runtime.sendMessage({ type: "backup/export" }) as Promise<{ ok: boolean; data: Record<string, unknown> }>);
      if (!res.ok) throw new Error("Export failed");
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `asguard-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
    setExporting(false);
  }

  function handleImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text) as Record<string, unknown>;
        // Validate: must have at least one known key
        const validKeys = ["asguard.templates", "asguard.simanTemplates", "asguard.llmSettings", "asguard.notifSettings"];
        const hasValid = validKeys.some((k) => k in data);
        if (!hasValid) { setImportStatus("error"); setImportMsg("File tidak valid"); return; }
        // Only import known keys
        const filtered: Record<string, unknown> = {};
        for (const k of validKeys) { if (k in data) filtered[k] = data[k]; }
        await chrome.runtime.sendMessage({ type: "backup/import", data: filtered });
        setImportStatus("done");
        setImportMsg(`Berhasil: ${Object.keys(filtered).length} data diimpor`);
      } catch {
        setImportStatus("error");
        setImportMsg("Gagal membaca file");
      }
      setTimeout(() => setImportStatus("idle"), 3000);
    };
    input.click();
  }

  return (
    <section class="card">
      <h2 class="card__title">Backup &amp; Restore</h2>
      <p class="hint">Ekspor template &amp; pengaturan ke file JSON. Impor untuk memulihkan.</p>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn--secondary" onClick={handleExport} disabled={exporting}>
          {exporting ? "Mengekspor…" : <><Icon name="arrow-up" /> Ekspor</>}
        </button>
        <button class="btn btn--secondary" onClick={handleImport}>
          <Icon name="arrow-down" /> Impor
        </button>
      </div>
      {importStatus !== "idle" && (
        <p class="hint" style={`margin-top:6px;color:${importStatus === "done" ? "var(--color-primary)" : "var(--error)"}`}>
          {importStatus === "done" ? <Icon name="circle-check" /> : <Icon name="circle-x" />} {importMsg}
        </p>
      )}
    </section>
  );
}
