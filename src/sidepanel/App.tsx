import { useEffect, useState } from "preact/hooks";
import type { LicenseStatus, NaskahTemplate, PanelSnapshot } from "@/shared/types";
import { SummaryView } from "./views/SummaryView";
import { SettingsView } from "./views/SettingsView";
import { TemplateListView } from "./views/TemplateListView";
import { TemplateDetailView } from "./views/TemplateDetailView";
import { MailMergeView } from "./views/MailMergeView";
import { ArsipView } from "./views/ArsipView";
import { SimanHomeView } from "./views/SimanHomeView";
import { SimanTemplateListView } from "./views/SimanTemplateListView";
import { SimanTemplateDetailView } from "./views/SimanTemplateDetailView";
import { SimanDaftarView } from "./views/SimanDaftarView";
import { SimanRunView } from "./views/SimanRunView";
import { SimanSopView } from "./views/SimanSopView";

type ActiveView = "home" | "summary" | "template" | "settings" | "arsiparis" | "update";
type SubView = { kind: "list" } | { kind: "detail"; templateId: string } | { kind: "mailmerge"; templateId: string };
type SimanView =
  | { kind: "home" }
  | { kind: "template-list" }
  | { kind: "template-detail"; templateId: string }
  | { kind: "daftar" }
  | { kind: "sop" }
  | { kind: "run"; noTiket: string; idPengelolaan: string; idTipePengelolaan: string; templateId: string };

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

export function App() {
  const [snap, setSnap] = useState<PanelSnapshot | null>(null);
  const [view, setView] = useState<ActiveView>("home");
  const [subView, setSubView] = useState<SubView>({ kind: "list" });
  const [activeTab, setActiveTab] = useState<"nadine" | "siman">("nadine");
  const [simanView, setSimanView] = useState<SimanView>({ kind: "home" });
  const [updateInfo, setUpdateInfo] = useState<{ available: boolean; latestVersion: string; downloadUrl: string | null; changelog: string | null } | null>(null);

  useEffect(() => {
    send<PanelSnapshot>({ type: "state/get" }).then((s) => {
      setSnap(s);
      setActiveTab(s.activeTab ?? "nadine");
    }).catch(console.error);

    // Check for cached update info
    send<{ available?: boolean; latestVersion?: string; downloadUrl?: string | null; changelog?: string | null } | null>({ type: "update/get-cached" })
      .then((u) => { if (u?.available) setUpdateInfo(u as typeof updateInfo); })
      .catch(() => {});

    const onMsg = (msg: { type?: string; snapshot?: PanelSnapshot }) => {
      if (msg?.type === "state/changed" && msg.snapshot) {
        setSnap(msg.snapshot);
        setActiveTab(msg.snapshot.activeTab ?? "nadine");
        if (msg.snapshot.pendingPayload) setView("home");
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  const hasToken = !!snap?.token?.token;
  const ndId = snap?.currentNdId ||
    (snap?.lastPage?.page.kind === "detail" ? snap.lastPage.page.ndId : null);
  const hasPending = !!snap?.pendingPayload;

  function goHome() { setView("home"); }

  const tabBar = (
    <div class="tab-bar">
      <button
        class={`tab-bar__tab${activeTab === "nadine" ? " tab-bar__tab--active-nadine" : ""}`}
        onClick={() => setActiveTab("nadine")}
      >📄 Nadine</button>
      <button
        class={`tab-bar__tab${activeTab === "siman" ? " tab-bar__tab--active-siman" : ""}`}
        onClick={() => setActiveTab("siman")}
      >🏛 SIMAN</button>
    </div>
  );

  const licenseStatus = snap?.licenseStatus ?? null;
  const licenseBlocked = licenseStatus !== null &&
    !licenseStatus.valid &&
    licenseStatus.status !== "offline" &&
    licenseStatus.status !== "error";

  const defaultSimanSnap: PanelSnapshot = {
    token: { token: null, capturedAt: null, origin: null, nip: null, fullname: null },
    lastPage: null,
    currentNdId: null,
    simanToken: { token: null, capturedAt: null, userId: null, nip: null, fullname: null, jabatan: null, role: null },
    activeTab: "siman",
    licenseStatus: null,
  };

  if (licenseBlocked) {
    return (
      <div class="panel">
        {tabBar}
        <main class="panel__main">
          <LicenseGate status={licenseStatus!} onRecheck={() => send({ type: "license/check" })} />
        </main>
        <footer class="panel__footer">Asguard · v0.2.2</footer>
      </div>
    );
  }

  if (activeTab === "siman") {
    if (simanView.kind === "template-list") {
      return (
        <div class="panel">
          {tabBar}
          <BackHeader title="Template Pengelolaan" onBack={() => setSimanView({ kind: "home" })} />
          <main class="panel__main">
            <SimanTemplateListView
              snap={snap ?? defaultSimanSnap}
              onEdit={(id) => setSimanView({ kind: "template-detail", templateId: id })}
              onBack={() => setSimanView({ kind: "home" })}
            />
          </main>
        </div>
      );
    }
    if (simanView.kind === "template-detail") {
      return (
        <div class="panel">
          {tabBar}
          <BackHeader title="Detail Template" onBack={() => setSimanView({ kind: "template-list" })} />
          <main class="panel__main">
            <SimanTemplateDetailView
              templateId={simanView.templateId}
              onBack={() => setSimanView({ kind: "template-list" })}
            />
          </main>
        </div>
      );
    }
    if (simanView.kind === "daftar") {
      return (
        <div class="panel">
          {tabBar}
          <BackHeader title="Daftar Pengelolaan" onBack={() => setSimanView({ kind: "home" })} />
          <main class="panel__main">
            <SimanDaftarView
              snap={snap ?? defaultSimanSnap}
              onRun={(noTiket, idPengelolaan, idTipePengelolaan, templateId) =>
                setSimanView({ kind: "run", noTiket, idPengelolaan, idTipePengelolaan, templateId })}
              onGoSop={() => setSimanView({ kind: "sop" })}
              onBack={() => setSimanView({ kind: "home" })}
            />
          </main>
        </div>
      );
    }
    if (simanView.kind === "sop") {
      return (
        <div class="panel">
          {tabBar}
          <BackHeader title="Tarik SOP Pengelolaan BMN" onBack={() => setSimanView({ kind: "daftar" })} />
          <main class="panel__main">
            <SimanSopView />
          </main>
        </div>
      );
    }
    if (simanView.kind === "run") {
      return (
        <div class="panel">
          {tabBar}
          <BackHeader title="Buat Naskah" onBack={() => setSimanView({ kind: "daftar" })} />
          <main class="panel__main">
            <SimanRunView
              key={`${simanView.noTiket}-${simanView.templateId}`}
              noTiket={simanView.noTiket}
              idPengelolaan={simanView.idPengelolaan}
              idTipePengelolaan={simanView.idTipePengelolaan}
              templateId={simanView.templateId}
              onDone={() => setSimanView({ kind: "daftar" })}
              onBack={() => setSimanView({ kind: "daftar" })}
            />
          </main>
        </div>
      );
    }
    // SIMAN home
    return (
      <div class="panel">
        {tabBar}
        <main class="panel__main">
          <LicenseCard
            status={licenseStatus}
            nip={snap?.token?.nip ?? snap?.simanToken?.nip ?? null}
            onRecheck={() => send({ type: "license/check" })}
          />
          {updateInfo?.available && <UpdateBanner info={updateInfo} />}
          <SimanHomeView
            snap={snap ?? defaultSimanSnap}
            onGoTemplates={() => setSimanView({ kind: "template-list" })}
            onGoDaftar={() => setSimanView({ kind: "daftar" })}
            onGantiRole={() => send({ type: "siman/token-clear" })}
          />
        </main>
        <footer class="panel__footer">Asguard · v0.2.2</footer>
      </div>
    );
  }

  // --- Routing ---
  if (view === "update") {
    return (
      <div class="panel">
        {tabBar}
        <BackHeader title="Pembaruan" onBack={goHome} />
        <main class="panel__main"><UpdateView /></main>
      </div>
    );
  }

  if (view === "arsiparis") {
    return (
      <div class="panel">
        {tabBar}
        <BackHeader title="Arsiparis" onBack={goHome} />
        <main class="panel__main"><ArsipView onBack={goHome} /></main>
      </div>
    );
  }

  if (view === "settings") {
    return (
      <div class="panel">
        {tabBar}
        <BackHeader title="Pengaturan" onBack={goHome} />
        <main class="panel__main"><SettingsView onBack={goHome} /></main>
      </div>
    );
  }

  if (view === "template") {
    if (subView.kind === "mailmerge") {
      return (
        <div class="panel">
          {tabBar}
          <BackHeader title="Mail Merge" onBack={() => setSubView({ kind: "list" })} />
          <main class="panel__main">
            <MailMergeView
              templateId={subView.templateId}
              onBack={() => setSubView({ kind: "list" })}
            />
          </main>
        </div>
      );
    }
    if (subView.kind === "detail") {
      return (
        <div class="panel">
          {tabBar}
          <BackHeader title="Detail Template" onBack={() => setSubView({ kind: "list" })} />
          <main class="panel__main">
            <TemplateDetailView
              templateId={subView.templateId}
              onBack={() => setSubView({ kind: "list" })}
              onMailMerge={(id: string) => setSubView({ kind: "mailmerge", templateId: id })}
            />
          </main>
        </div>
      );
    }
    return (
      <div class="panel">
        {tabBar}
        <BackHeader title="Template" onBack={goHome} />
        <main class="panel__main">
          <TemplateListView
            onEdit={(t: NaskahTemplate) => setSubView({ kind: "detail", templateId: t.id })}
            onMailMerge={(t: NaskahTemplate) => setSubView({ kind: "mailmerge", templateId: t.id })}
          />
        </main>
      </div>
    );
  }

  if (view === "summary") {
    return (
      <div class="panel">
        {tabBar}
        <BackHeader title="Ringkasan AI" onBack={goHome} />
        <main class="panel__main">
          {hasToken && ndId
            ? <SummaryView ndId={ndId} />
            : <TokenWarning />}
        </main>
      </div>
    );
  }

  // --- Home view ---
  return (
    <div class="panel">
      {tabBar}
      <HomeHeader ndId={ndId} snap={snap} />
      <main class="panel__main panel__main--home">
        {/* New naskah banner */}
        {hasPending && (
          <div class="home-banner fade-in">
            <span class="home-banner__icon">📋</span>
            <span class="home-banner__text">Naskah baru terdeteksi</span>
            <button class="home-banner__btn" onClick={() => { setView("template"); setSubView({ kind: "list" }); }}>
              Simpan Template
            </button>
          </div>
        )}

        {/* License status card */}
        <LicenseCard status={licenseStatus} nip={snap?.token?.nip ?? snap?.simanToken?.nip ?? null} onRecheck={() => send({ type: "license/check" })} />

        {/* Update banner */}
        {updateInfo?.available && <UpdateBanner info={updateInfo} />}

        {/* Nadine user + role */}
        {hasToken && <NadineUserCard />}

        {/* No token warning */}
        {!hasToken && <TokenWarning />}

        {/* Action cards */}
        {hasToken && (
          <div class="action-cards">
            <button
              class="action-card"
              onClick={() => setView("summary")}
              disabled={!ndId}
              title={!ndId ? "Buka naskah di Nadine terlebih dahulu" : undefined}
            >
              <div class="action-card__icon">✨</div>
              <div class="action-card__body">
                <div class="action-card__label">Ringkas dengan AI</div>
                <div class="action-card__desc">
                  {ndId ? "Klik untuk meringkas naskah ini" : "Buka naskah di Nadine terlebih dahulu"}
                </div>
              </div>
              <span class="action-card__arrow">›</span>
            </button>

            <button class="action-card" onClick={() => { setView("template"); setSubView({ kind: "list" }); }}>
              <div class="action-card__icon">📋</div>
              <div class="action-card__body">
                <div class="action-card__label">Template</div>
                <div class="action-card__desc">Buat naskah dari template tersimpan</div>
              </div>
              {hasPending && <span class="action-card__badge">Baru</span>}
              <span class="action-card__arrow">›</span>
            </button>

            <button class="action-card" onClick={() => setView("arsiparis")}>
              <div class="action-card__icon">📦</div>
              <div class="action-card__body">
                <div class="action-card__label">Arsiparis</div>
                <div class="action-card__desc">Arsipkan naskah ke E-Arsip</div>
              </div>
              <span class="action-card__arrow">›</span>
            </button>

          </div>
        )}

        {/* Always visible */}
        <div class="action-cards">
          <button class="action-card" onClick={() => setView("settings")}>
            <div class="action-card__icon">⚙️</div>
            <div class="action-card__body">
              <div class="action-card__label">Pengaturan</div>
              <div class="action-card__desc">Model AI, preferensi, backup</div>
            </div>
            <span class="action-card__arrow">›</span>
          </button>

          <button class="action-card" onClick={() => setView("update")}>
            <div class="action-card__icon">🔄</div>
            <div class="action-card__body">
              <div class="action-card__label">Pembaruan</div>
              <div class="action-card__desc">
                {updateInfo?.available ? `v${updateInfo.latestVersion} tersedia!` : `v${chrome.runtime.getManifest().version} · Cek pembaruan`}
              </div>
            </div>
            {updateInfo?.available && <span class="action-card__badge">Baru</span>}
            <span class="action-card__arrow">›</span>
          </button>
        </div>
      </main>
      <footer class="panel__footer">Asguard · v0.2.2</footer>
    </div>
  );
}

// --- Sub-components ---

function HomeHeader({ ndId, snap }: { ndId: string | null; snap: PanelSnapshot | null }) {
  const hasToken = !!snap?.token?.token;
  return (
    <header class="panel__header panel__header--home">
      <div class="panel__brand">
        <span class="panel__mark">◆</span>
        <h1 class="panel__title">Asguard</h1>
      </div>
      {hasToken && ndId && (
        <div class="panel__nd-context">
          <span class="panel__nd-id">ND · {ndId}</span>
        </div>
      )}
    </header>
  );
}

function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header class="panel__header">
      <button class="panel__back" onClick={onBack} title="Kembali">‹</button>
      <h1 class="panel__title">{title}</h1>
    </header>
  );
}

function TokenWarning() {
  return (
    <section class="card card--warn fade-in">
      <div class="row">
        <span class="row__label">Sesi Nadine</span>
        <span class="row__value">
          <span class="dot dot--warn" /> menunggu
        </span>
      </div>
      <p class="hint">
        Buka/refresh <code>satu.kemenkeu.go.id</code> — token tertangkap otomatis saat
        Nadine memanggil API pertamanya.
      </p>
    </section>
  );
}

function LicenseCard({ status, nip, onRecheck }: { status: LicenseStatus | null; nip: string | null; onRecheck: () => void }) {
  if (!status) {
    return (
      <section class="card fade-in" style="margin:8px 12px;padding:8px 12px">
        <div style="display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px">
          <span class="dot dot--warn" /> Memeriksa lisensi…
        </div>
      </section>
    );
  }

  const dotColor = status.valid ? (status.status === "trial" ? "dot--warn" : "dot--ok") : "dot--err";
  const label = status.status === "active"
    ? `Aktif${status.expires ? ` · s/d ${status.expires.slice(0, 10)}` : " · lifetime"}`
    : status.status === "trial"
    ? `Trial · ${status.days_remaining} hari tersisa`
    : status.message;

  return (
    <section class="card fade-in" style="margin:8px 12px;padding:8px 12px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:6px;font-size:12px">
          <span class={`dot ${dotColor}`} />
          <span>{label}</span>
        </div>
        {(!status.valid || status.status === "offline") && (
          <button class="btn btn--ghost" style="font-size:11px;padding:2px 8px" onClick={onRecheck}>
            Cek Ulang
          </button>
        )}
      </div>
      {nip && <div style="font-size:10px;color:var(--muted);margin-top:2px">NIP {nip}</div>}
    </section>
  );
}

function LicenseGate({ status, onRecheck }: { status: LicenseStatus; onRecheck: () => void }) {
  return (
    <section class="card card--warn fade-in" style="margin:16px">
      <p style="font-weight:600;margin-bottom:4px">Akses Terbatas</p>
      <p class="hint">{status.message}</p>
      <button class="btn btn--primary" style="margin-top:10px;width:100%" onClick={onRecheck}>
        Cek Ulang Lisensi
      </button>
    </section>
  );
}

function UpdateBanner({ info }: { info: { latestVersion: string; downloadUrl: string | null; changelog: string | null } }) {
  return (
    <section class="card fade-in" style="margin:8px 12px;padding:10px 12px;border:1px solid color-mix(in srgb, #f59e0b 40%, transparent);background:color-mix(in srgb, #f59e0b 8%, transparent)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div>
          <div style="font-size:12px;font-weight:600;color:#f59e0b">📦 Update v{info.latestVersion}</div>
          {info.changelog && <div style="font-size:11px;color:var(--muted);margin-top:2px">{info.changelog}</div>}
        </div>
        {info.downloadUrl && (
          <button
            class="btn btn--primary"
            style="font-size:11px;padding:5px 12px;flex-shrink:0;background:#f59e0b;border-color:#f59e0b"
            onClick={() => chrome.tabs.create({ url: info.downloadUrl! })}
          >
            Unduh
          </button>
        )}
      </div>
    </section>
  );
}

function UpdateView() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ available: boolean; latestVersion: string; currentVersion: string; downloadUrl: string | null; changelog: string | null } | null>(null);

  async function check() {
    setChecking(true);
    try {
      const r = await send<typeof result>({ type: "update/check" });
      setResult(r);
    } catch { /* ignore */ }
    setChecking(false);
  }

  const version = chrome.runtime.getManifest().version;

  return (
    <div style="padding:12px;display:flex;flex-direction:column;gap:12px" class="fade-in">
      {/* Current version + check */}
      <section class="card" style="padding:12px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text-primary)">Asguard Extension</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px">Versi saat ini: <strong>v{version}</strong></div>
          </div>
          <button class="btn btn--primary" style="font-size:11px;padding:6px 14px" onClick={check} disabled={checking}>
            {checking ? "Memeriksa…" : "🔄 Cek Update"}
          </button>
        </div>

        {result && !result.available && (
          <div style="margin-top:8px;padding:8px;background:color-mix(in srgb, var(--color-primary) 10%, transparent);border-radius:var(--radius-sm);font-size:12px;color:var(--color-primary)">
            ✅ Sudah versi terbaru
          </div>
        )}

        {result?.available && (
          <div style="margin-top:8px;padding:10px;background:color-mix(in srgb, #f59e0b 8%, transparent);border:1px solid color-mix(in srgb, #f59e0b 30%, transparent);border-radius:var(--radius-sm)">
            <div style="font-size:13px;font-weight:600;color:#f59e0b">📦 v{result.latestVersion} tersedia!</div>
            {result.changelog && <div style="font-size:11px;color:var(--muted);margin-top:4px">{result.changelog}</div>}
            {result.downloadUrl && (
              <button
                class="btn btn--primary"
                style="margin-top:8px;font-size:12px;padding:6px 16px;background:#f59e0b;border-color:#f59e0b;width:100%"
                onClick={() => chrome.tabs.create({ url: result.downloadUrl! })}
              >
                ⬇ Unduh v{result.latestVersion}
              </button>
            )}
          </div>
        )}
      </section>

      {/* Install tutorial */}
      <section class="card" style="padding:12px">
        <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px">📖 Cara Install / Update</div>

        <div style="font-size:12px;color:var(--text-primary);display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;gap:8px">
            <span style="font-weight:700;color:var(--color-primary);flex-shrink:0">1.</span>
            <span>Unduh file ZIP dari tombol di atas atau dari link yang diberikan admin</span>
          </div>
          <div style="display:flex;gap:8px">
            <span style="font-weight:700;color:var(--color-primary);flex-shrink:0">2.</span>
            <span>Ekstrak file ZIP tersebut. Jika update, timpa (replace) folder extension yang lama</span>
          </div>
          <div style="display:flex;gap:8px">
            <span style="font-weight:700;color:var(--color-primary);flex-shrink:0">3.</span>
            <span>Buka Chrome, ketik <code style="background:var(--surface-2);padding:1px 4px;border-radius:3px">chrome://extensions</code> di address bar</span>
          </div>
          <div style="display:flex;gap:8px">
            <span style="font-weight:700;color:var(--color-primary);flex-shrink:0">4.</span>
            <span>Aktifkan <strong>Developer mode</strong> (toggle di kanan atas)</span>
          </div>
          <div style="display:flex;gap:8px">
            <span style="font-weight:700;color:var(--color-primary);flex-shrink:0">5.</span>
            <span>
              {result?.available
                ? <>Klik tombol 🔄 <strong>reload</strong> pada kartu Asguard</>
                : <>Klik <strong>Load unpacked</strong> → pilih folder hasil ekstrak (yang berisi <code style="background:var(--surface-2);padding:1px 4px;border-radius:3px">manifest.json</code>)</>
              }
            </span>
          </div>
          <div style="display:flex;gap:8px">
            <span style="font-weight:700;color:var(--color-primary);flex-shrink:0">6.</span>
            <span>Selesai! Extension akan aktif. Buka Nadine/SIMAN seperti biasa.</span>
          </div>
        </div>

        <div style="margin-top:10px;padding:8px;background:var(--surface-2);border-radius:var(--radius-sm);font-size:11px;color:var(--muted)">
          💡 <strong>Data aman</strong> — Template, pengaturan, dan data lainnya tidak akan hilang saat update. Hanya file program yang diganti.
        </div>
      </section>
    </div>
  );
}

function NadineUserCard() {
  const [currentRole, setCurrentRole] = useState<{ RoleName?: string; UnitName?: string; RoleId?: string } | null>(null);
  const [allUnits, setAllUnits] = useState<Record<string, unknown>[]>([]);
  const [nama, setNama] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => { loadMe(); }, []);

  async function loadMe() {
    const r = await send<{ ok: boolean; data?: { Data?: { Nama?: string; CurrentUnit?: Record<string, unknown>; AllUnits?: Record<string, unknown>[] } } }>({ type: "api/me" });
    if (r.ok && r.data?.Data) {
      const d = r.data.Data;
      setNama(String(d.Nama ?? ""));
      setCurrentRole((d.CurrentUnit as typeof currentRole) ?? null);
      setAllUnits(d.AllUnits ?? []);
    }
  }

  async function switchTo(unit: Record<string, unknown>) {
    if (String(unit.RoleId) === String(currentRole?.RoleId)) { setShowPicker(false); return; }
    setSwitching(true);
    await send({ type: "api/switch-role", unitData: unit });
    await loadMe();
    setSwitching(false);
    setShowPicker(false);
  }

  if (!currentRole) return null;

  return (
    <section class="card fade-in" style="margin:8px 12px;padding:10px 12px">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:32px;height:32px;border-radius:50%;background:color-mix(in srgb, var(--color-primary) 15%, transparent);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">👤</div>
        <div style="flex:1;min-width:0">
          {nama && <div style="font-size:12px;font-weight:600;color:var(--text-primary)">{nama}</div>}
          <div style="font-size:11px;color:var(--color-primary);margin-top:1px">{currentRole.RoleName}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{currentRole.UnitName}</div>
        </div>
        {allUnits.length > 1 && (
          <button class="btn btn--ghost" style="font-size:10px;padding:3px 8px;flex-shrink:0" onClick={() => setShowPicker(!showPicker)}>
            🔄 Ganti
          </button>
        )}
      </div>
      {showPicker && (
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:4px">
          {allUnits.map((u, i) => {
            const active = String(u.RoleId) === String(currentRole.RoleId);
            return (
              <button
                key={i}
                class="btn btn--ghost"
                style={`text-align:left;padding:6px 8px;font-size:11px;border-radius:var(--radius-sm)${active ? ";background:color-mix(in srgb, var(--color-primary) 10%, transparent)" : ""}${switching ? ";opacity:0.5" : ""}`}
                onClick={() => switchTo(u)}
                disabled={switching}
              >
                <div style="font-weight:600;color:var(--text-primary)">{String(u.RoleName ?? "-")}{active ? " ✓" : ""}</div>
                <div style="font-size:10px;color:var(--muted);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{String(u.UnitName ?? "")}</div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
