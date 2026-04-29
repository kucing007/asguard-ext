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

type ActiveView = "home" | "summary" | "template" | "settings" | "arsiparis";
type SubView = { kind: "list" } | { kind: "detail"; templateId: string } | { kind: "mailmerge"; templateId: string };
type SimanView =
  | { kind: "home" }
  | { kind: "template-list" }
  | { kind: "template-detail"; templateId: string }
  | { kind: "daftar" }
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

  useEffect(() => {
    send<PanelSnapshot>({ type: "state/get" }).then((s) => {
      setSnap(s);
      setActiveTab(s.activeTab ?? "nadine");
    }).catch(console.error);

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
        <footer class="panel__footer" style="display:flex;justify-content:space-between;align-items:center">
        <span>Asguard · v0.2.0</span>
        <LicenseBar status={licenseStatus} />
      </footer>
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
              onBack={() => setSimanView({ kind: "home" })}
            />
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
          <SimanHomeView
            snap={snap ?? defaultSimanSnap}
            onGoTemplates={() => setSimanView({ kind: "template-list" })}
            onGoDaftar={() => setSimanView({ kind: "daftar" })}
            onGantiRole={() => send({ type: "siman/token-clear" })}
          />
        </main>
        <footer class="panel__footer" style="display:flex;justify-content:space-between;align-items:center">
        <span>Asguard · v0.2.0</span>
        <LicenseBar status={licenseStatus} />
      </footer>
      </div>
    );
  }

  // --- Routing ---
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

        {/* License trial/offline banner */}
        {licenseStatus?.status === "trial" && licenseStatus.valid && (
          <div class="home-banner fade-in" style="background:var(--warn-bg,#fff8e1)">
            <span class="home-banner__icon">⏳</span>
            <span class="home-banner__text">Trial aktif · {licenseStatus.days_remaining} hari tersisa</span>
          </div>
        )}
        {(licenseStatus?.status === "offline" || licenseStatus?.status === "error") && (
          <div class="home-banner fade-in" style="background:var(--warn-bg,#fff8e1)">
            <span class="home-banner__icon">⚠️</span>
            <span class="home-banner__text">{licenseStatus.message}</span>
          </div>
        )}

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

            <button class="action-card" onClick={() => setView("settings")}>
              <div class="action-card__icon">⚙️</div>
              <div class="action-card__body">
                <div class="action-card__label">Pengaturan</div>
                <div class="action-card__desc">Model AI, preferensi</div>
              </div>
              <span class="action-card__arrow">›</span>
            </button>
          </div>
        )}
      </main>
      <footer class="panel__footer" style="display:flex;justify-content:space-between;align-items:center">
        <span>Asguard · v0.2.0</span>
        <LicenseBar status={licenseStatus} />
      </footer>
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

function LicenseBar({ status }: { status: LicenseStatus | null }) {
  if (!status) return <span style="color:var(--muted);font-size:10px">memeriksa lisensi…</span>;
  if (status.status === "active") {
    const exp = status.expires ? ` · s/d ${status.expires.slice(0, 10)}` : " · lifetime";
    return <span style="color:#4caf50;font-size:10px">✓ Aktif{exp}</span>;
  }
  if (status.status === "trial") {
    return <span style="color:#ff9800;font-size:10px">⏳ Trial · {status.days_remaining} hari</span>;
  }
  if (status.status === "offline" || status.status === "error") {
    return <span style="color:var(--muted);font-size:10px">⚠ {status.message}</span>;
  }
  return <span style="color:#f44336;font-size:10px">✗ {status.message}</span>;
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
