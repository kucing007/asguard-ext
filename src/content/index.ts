import { classifyUrl } from "./page-detector";
import { debugLog } from "@/shared/logging";
import type { BgMessage, PageContext } from "@/shared/types";

function send(msg: BgMessage) {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* service worker may be asleep between navigations */
  });
}

function currentContext(): PageContext {
  return { url: location.href, page: classifyUrl(location.href) };
}

let lastUrl = "";
function emitPageIfChanged() {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  send({ type: "page/changed", ctx: currentContext() });
}

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const d = ev.data as {
    __asguard?: boolean;
    kind?: string;
    token?: string;
    origin?: string;
    ndId?: string;
    base64?: string;
    url?: string;
    size?: number;
    payload?: Record<string, unknown>;
    roleData?: Record<string, unknown>;
    body?: Record<string, unknown>;
  };
  if (!d || !d.__asguard) return;
  if (d.kind === "token" && d.token && d.origin) {
    send({ type: "token/capture", token: d.token, origin: d.origin });
  } else if (d.kind === "ndId" && d.ndId) {
    send({ type: "viewing/ndId", ndId: d.ndId });
  } else if (d.kind === "pdf" && d.base64 && d.url) {
    // Forward captured PDF to background
    debugLog("[asguard] forwarding captured PDF", { size: d.size });
    send({ type: "pdf/captured", base64: d.base64, url: d.url, size: d.size ?? 0 });
  } else if (d.kind === "createPayload" && d.payload && d.url) {
    // Forward captured CreateNaskahPayload to background for template saving
    debugLog("[asguard] forwarding CreateNaskahPayload to background");
    send({ type: "naskah/created", payload: d.payload as Record<string, unknown>, url: d.url });
  } else if (d.kind === "simanToken" && d.token && d.origin) {
    send({ type: "siman/token", token: d.token, origin: d.origin });
  } else if (d.kind === "simanRoleData" && d.roleData) {
    send({ type: "siman/role-data", roleData: d.roleData });
  } else if (d.kind === "simanPenetapanBody" && d.body) {
    send({ type: "siman/penetapan-body", body: d.body });
  }
});

emitPageIfChanged();

window.addEventListener("popstate", emitPageIfChanged);
window.addEventListener("hashchange", emitPageIfChanged);

const origPush = history.pushState;
const origReplace = history.replaceState;
history.pushState = function (...args) {
  const r = origPush.apply(this, args as Parameters<typeof history.pushState>);
  queueMicrotask(emitPageIfChanged);
  return r;
};
history.replaceState = function (...args) {
  const r = origReplace.apply(this, args as Parameters<typeof history.replaceState>);
  queueMicrotask(emitPageIfChanged);
  return r;
};

debugLog("[asguard] content script ready", { host: location.hostname });

// ── Tinjut badge injection on penetapan-permohonan page ──

const TINJUT_ATTR = "data-asguard-tinjut";
let tinjutTimer: ReturnType<typeof setTimeout> | null = null;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface RekamFile {
  id: number;
  no: number;
  jenisDok: string;
  nmDok: string;
  noBukti: string;
  tglBukti: string;
  nmFile: string;
}

interface TinjutInfo {
  status: string;
  lastStatus: string;
  lastDate: string;
  lastBy: string;
  lastRole: string;
  kodeStatus: string;
  rekamFiles?: RekamFile[];
  skNo?: string;
  skTgl?: string;
  skPenandatangan?: string;
}
const tinjutCache = new Map<string, TinjutInfo>();

function isTinjutPage(): boolean {
  return location.hostname === "siman.kemenkeu.go.id" &&
    location.pathname.includes("/pengelolaan/penetapan-permohonan");
}

function findTicketButtons(): HTMLElement[] {
  const btns = document.querySelectorAll<HTMLElement>(
    "datatable-body-cell .btn.btn-sm",
  );
  return Array.from(btns).filter(
    (b) => b.textContent?.trim().startsWith("PPL") && !b.hasAttribute(TINJUT_ATTR),
  );
}

let aksiColumnWidened = false;
const AKSI_NEW_WIDTH = 170;
const AKSI_WIDTH_DIFF = 90;

function widenAksiColumn() {
  if (aksiColumnWidened) return;
  aksiColumnWidened = true;

  const headerLeft = document.querySelector("datatable-header .datatable-row-left");
  if (headerLeft) {
    const headerCells = headerLeft.querySelectorAll<HTMLElement>("datatable-header-cell");
    if (headerCells[1]) headerCells[1].style.width = `${AKSI_NEW_WIDTH}px`;
    const el = headerLeft as HTMLElement;
    el.style.width = `${(parseInt(el.style.width) || 610) + AKSI_WIDTH_DIFF}px`;
  }

  const bodyLeftGroups = document.querySelectorAll<HTMLElement>(
    "datatable-body .datatable-row-left",
  );
  for (const group of bodyLeftGroups) {
    const cells = group.querySelectorAll<HTMLElement>("datatable-body-cell");
    if (cells[1]) cells[1].style.width = `${AKSI_NEW_WIDTH}px`;
    group.style.width = `${(parseInt(group.style.width) || 610) + AKSI_WIDTH_DIFF}px`;
  }
}

function getBadgeColor(status: string): string {
  if (status === "Sudah Tinjut") return "#28a745"; // green
  if (status === "Ada Bukti") return "#ffc107";     // yellow
  return "#dc3545";                                  // red
}

function getBadgeTextColor(status: string): string {
  if (status === "Ada Bukti") return "#333";  // dark text on yellow
  return "#fff";                               // white text on green/red
}

function formatDate(iso: string): string {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" }) +
      " " + d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

/** Calculate duration from a date string to today as "X Tahun Y Bulan Z Hari" */
function formatDuration(dateStr: string): string {
  if (!dateStr || dateStr === "9999-01-01") return "";
  const from = new Date(dateStr + "T00:00:00");
  const now = new Date();
  if (isNaN(from.getTime())) return "";

  let months = (now.getFullYear() - from.getFullYear()) * 12 + (now.getMonth() - from.getMonth());
  let days = now.getDate() - from.getDate();
  if (days < 0) {
    months--;
    const prev = new Date(now.getFullYear(), now.getMonth(), 0);
    days += prev.getDate();
  }
  if (months < 0) return "";

  const years = Math.floor(months / 12);
  months = months % 12;

  const parts: string[] = [];
  if (years > 0) parts.push(`${years} Tahun`);
  if (months > 0) parts.push(`${months} Bulan`);
  if (days > 0 || parts.length === 0) parts.push(`${days} Hari`);
  return parts.join(" ");
}

/** Build SK info section HTML for popup */
function buildSkHtml(info: TinjutInfo): string {
  if (info.status !== "Belum Tinjut" && info.status !== "Ada Bukti") return "";
  if (!info.skNo && !info.skTgl) return "";

  const duration = info.skTgl ? formatDuration(info.skTgl) : "";
  const durationBadge = duration
    ? `<span style="display:inline-block;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:700;
        background:#fff3cd;color:#856404;margin-left:6px;">⏱ ${duration}</span>`
    : "";

  return `
    <div style="margin-top:8px;border-top:1px solid #e0e0e0;padding-top:6px;">
      <div style="display:flex;align-items:center;margin-bottom:4px;">
        <span style="font-size:11px;font-weight:700;color:#555;">📄 SK Persetujuan</span>
        ${durationBadge}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
        <tr><td style="padding:2px 6px 2px 0;color:#888;white-space:nowrap;vertical-align:top;">No SK</td>
            <td style="padding:2px 0;font-weight:600;">${escapeHtml(info.skNo || "-")}</td></tr>
        <tr><td style="padding:2px 6px 2px 0;color:#888;white-space:nowrap;vertical-align:top;">Tgl SK</td>
            <td style="padding:2px 0;">${info.skTgl || "-"}</td></tr>
        <tr><td style="padding:2px 6px 2px 0;color:#888;white-space:nowrap;vertical-align:top;">Penandatangan</td>
            <td style="padding:2px 0;">${escapeHtml(info.skPenandatangan || "-")}</td></tr>
      </table>
    </div>
  `;
}

// ── Popup for tinjut detail ──
let activePopup: HTMLElement | null = null;

function closePopup() {
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
}

function showPopup(anchor: HTMLElement, info: TinjutInfo) {
  // Toggle: if already showing for this anchor, close it
  if (activePopup && activePopup.dataset.noTiket === anchor.dataset.noTiket) {
    closePopup();
    return;
  }
  closePopup();

  const popup = document.createElement("div");
  popup.dataset.noTiket = anchor.dataset.noTiket || "";
  popup.style.cssText = `
    position:fixed;z-index:99999;
    background:#fff;border:1px solid #ccc;border-radius:8px;
    box-shadow:0 4px 16px rgba(0,0,0,.18);
    padding:12px 16px;min-width:300px;max-width:440px;
    max-height:400px;overflow-y:auto;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    font-size:13px;color:#333;line-height:1.5;
  `;

  const statusColor = getBadgeColor(info.status);

  // Build rekam files section for "Ada Bukti"
  let rekamHtml = "";
  const rekamFilesForHandler: RekamFile[] = [];
  if (info.rekamFiles && info.rekamFiles.length > 0) {
    rekamFilesForHandler.push(...info.rekamFiles);
    const rows = info.rekamFiles.map(f => {
      const hasFile = f.nmFile && f.nmFile !== "-" && f.id > 0;
      const dlBtn = hasFile
        ? `<button data-rekam-dl-id="${f.id}" data-rekam-dl-file="${escapeHtml(f.nmFile)}" style="
            display:inline-flex;align-items:center;gap:3px;margin-top:3px;padding:2px 7px;
            border:1px solid #007bff;border-radius:3px;background:#fff;color:#007bff;
            font-size:10px;cursor:pointer;font-weight:600;
          ">⬇ Download</button>`
        : "";
      return `<tr style="border-bottom:1px solid #eee;">
        <td style="padding:4px 6px;color:#555;text-align:center;">${f.no}</td>
        <td style="padding:4px 6px;">
          <div style="font-weight:600;font-size:11px;color:#333;">${escapeHtml(f.jenisDok)}</div>
          <div style="font-size:10px;color:#666;margin-top:1px;">${escapeHtml(f.nmDok)}</div>
          ${f.noBukti && f.noBukti !== "-" ? `<div style="font-size:10px;color:#888;margin-top:1px;">No: ${escapeHtml(f.noBukti)}</div>` : ""}
          ${f.tglBukti && f.tglBukti !== "9999-01-01" ? `<div style="font-size:10px;color:#888;">Tgl: ${f.tglBukti}</div>` : ""}
          ${dlBtn}
        </td>
      </tr>`;
    }).join("");
    rekamHtml = `
      <div style="margin-top:8px;border-top:1px solid #e0e0e0;padding-top:6px;">
        <div style="font-size:11px;font-weight:700;color:#555;margin-bottom:4px;">📎 Dokumen Bukti (${info.rekamFiles.length})</div>
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead><tr style="background:#f5f5f5;">
            <th style="padding:3px 6px;text-align:center;color:#888;font-weight:600;width:28px;">No</th>
            <th style="padding:3px 6px;text-align:left;color:#888;font-weight:600;">Dokumen</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  const noTiketDisplay = escapeHtml(anchor.dataset.noTiket || "");

  popup.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
      <span style="display:inline-block;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;
        color:${getBadgeTextColor(info.status)};background:${statusColor};">${info.status}</span>
      <span style="color:#888;font-size:11px;">${info.kodeStatus}</span>
    </div>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
      <code data-asguard-tiket-copy style="font-size:11px;color:#0056b3;background:#eef4ff;padding:2px 6px;
        border-radius:3px;cursor:pointer;user-select:all;font-weight:600;" title="Klik untuk copy">${noTiketDisplay}</code>
      <button data-asguard-copy-btn style="border:none;background:none;cursor:pointer;font-size:13px;padding:0;
        line-height:1;" title="Copy nomor tiket">📋</button>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <tr><td style="padding:3px 8px 3px 0;color:#888;white-space:nowrap;vertical-align:top;">Status</td>
          <td style="padding:3px 0;font-weight:600;">${escapeHtml(info.lastStatus || "-")}</td></tr>
      <tr><td style="padding:3px 8px 3px 0;color:#888;white-space:nowrap;vertical-align:top;">Tanggal</td>
          <td style="padding:3px 0;">${formatDate(info.lastDate)}</td></tr>
      <tr><td style="padding:3px 8px 3px 0;color:#888;white-space:nowrap;vertical-align:top;">Oleh</td>
          <td style="padding:3px 0;">${escapeHtml(info.lastBy || "-")}</td></tr>
      <tr><td style="padding:3px 8px 3px 0;color:#888;white-space:nowrap;vertical-align:top;">Role</td>
          <td style="padding:3px 0;">${escapeHtml(info.lastRole || "-")}</td></tr>
    </table>
    ${buildSkHtml(info)}
    ${rekamHtml}
  `;

  document.body.appendChild(popup);
  activePopup = popup;

  // Position near the anchor badge
  const rect = anchor.getBoundingClientRect();
  const popW = popup.offsetWidth;
  const popH = popup.offsetHeight;
  let left = rect.right + 8;
  let top = rect.top - 4;
  // Keep within viewport
  if (left + popW > window.innerWidth - 8) left = rect.left - popW - 8;
  if (top + popH > window.innerHeight - 8) top = window.innerHeight - popH - 8;
  if (top < 8) top = 8;
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

  // Attach download click handlers
  popup.querySelectorAll<HTMLButtonElement>("[data-rekam-dl-id]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const id = Number(btn.dataset.rekamDlId);
      const nmFile = btn.dataset.rekamDlFile ?? "";
      if (!id || !nmFile) return;

      btn.textContent = "⏳ ...";
      btn.style.color = "#888";
      btn.style.borderColor = "#888";
      btn.disabled = true;

      try {
        const res = await chrome.runtime.sendMessage({
          type: "siman/get-download-token-model",
          id,
          filename: nmFile,
          model: "DKRTL",
        }) as { ok: boolean; url?: string; error?: string };

        if (res?.ok && res.url) {
          window.open(res.url, "_blank");
          btn.textContent = "✅ Opened";
          btn.style.color = "#28a745";
          btn.style.borderColor = "#28a745";
        } else {
          btn.textContent = "❌ Gagal";
          btn.style.color = "#dc3545";
          btn.style.borderColor = "#dc3545";
        }
      } catch {
        btn.textContent = "❌ Error";
        btn.style.color = "#dc3545";
        btn.style.borderColor = "#dc3545";
      }

      setTimeout(() => {
        btn.textContent = "⬇ Download";
        btn.style.color = "#007bff";
        btn.style.borderColor = "#007bff";
        btn.disabled = false;
      }, 2000);
    });
  });

  // Attach copy tiket handler
  const copyBtn = popup.querySelector("[data-asguard-copy-btn]");
  const tiketCode = popup.querySelector("[data-asguard-tiket-copy]");
  const doCopy = () => {
    const text = tiketCode?.textContent ?? "";
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      if (copyBtn) { copyBtn.textContent = "✅"; setTimeout(() => { copyBtn.textContent = "📋"; }, 1500); }
    });
  };
  copyBtn?.addEventListener("click", (e) => { e.stopPropagation(); doCopy(); });
  tiketCode?.addEventListener("click", (e) => { e.stopPropagation(); doCopy(); });
}

// Close popup when clicking outside
document.addEventListener("click", (e) => {
  if (activePopup && !activePopup.contains(e.target as Node)) {
    const badges = document.querySelectorAll("[data-asguard-tinjut-badge]");
    let clickedBadge = false;
    for (const b of badges) {
      if (b.contains(e.target as Node)) { clickedBadge = true; break; }
    }
    if (!clickedBadge) closePopup();
  }
}, true);

function injectBadge(btn: HTMLElement, info: TinjutInfo) {
  btn.setAttribute(TINJUT_ATTR, info.status);
  const badge = document.createElement("span");
  badge.textContent = info.status;
  badge.setAttribute("data-asguard-tinjut-badge", "1");
  const noTiket = btn.textContent?.trim() ?? "";
  badge.dataset.noTiket = noTiket;

  badge.style.cssText = `
    display:inline-block;margin-left:6px;padding:2px 6px;border-radius:3px;
    font-size:9px;font-weight:700;vertical-align:middle;white-space:nowrap;
    cursor:pointer;
    color:${getBadgeTextColor(info.status)};background:${getBadgeColor(info.status)};
    user-select:none;
  `;

  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    showPopup(badge, info);
  });

  // Navigate from ticket button → row group → find Aksi cell
  const rowGroup = btn.closest(".datatable-row-group");
  if (!rowGroup) return;

  const aksiBtn = rowGroup.querySelector("smn-button .fa-eye");
  if (aksiBtn) {
    const aksiCell = aksiBtn.closest("datatable-body-cell") as HTMLElement | null;
    if (aksiCell) {
      aksiCell.style.width = `${AKSI_NEW_WIDTH}px`;
      const label = aksiCell.querySelector(".datatable-body-cell-label") as HTMLElement | null;
      if (label) {
        // Remove any existing badges in this cell first (prevents stacking)
        label.querySelectorAll("[data-asguard-tinjut-badge]").forEach(old => old.remove());
        label.style.display = "flex";
        label.style.alignItems = "center";
        label.style.gap = "4px";
        label.appendChild(badge);
        return;
      }
    }
  }

  btn.insertAdjacentElement("afterend", badge);
}

// Track which tickets are currently displayed to detect table refresh
let lastKnownTickets = new Set<string>();

/** Remove all badges and reset state when table data has changed */
function cleanupStaleBadges() {
  closePopup();
  // Remove all badge elements
  document.querySelectorAll("[data-asguard-tinjut-badge]").forEach(el => el.remove());
  // Remove tinjut attr from all buttons so they can be re-processed
  document.querySelectorAll(`[${TINJUT_ATTR}]`).forEach(el => el.removeAttribute(TINJUT_ATTR));
  // Reset column widening — table may have been re-rendered with original widths
  aksiColumnWidened = false;
}

/** Get current set of visible PPL ticket numbers */
function getCurrentTicketSet(): Set<string> {
  const btns = document.querySelectorAll<HTMLElement>("datatable-body-cell .btn.btn-sm");
  const set = new Set<string>();
  for (const b of btns) {
    const t = b.textContent?.trim();
    if (t?.startsWith("PPL")) set.add(t);
  }
  return set;
}

async function checkAndInjectTinjut() {
  if (!isTinjutPage()) return;

  // Detect table refresh: if ticket set changed, cleanup old badges
  const currentTickets = getCurrentTicketSet();
  if (currentTickets.size > 0) {
    const changed = currentTickets.size !== lastKnownTickets.size ||
      [...currentTickets].some(t => !lastKnownTickets.has(t));
    if (changed) {
      cleanupStaleBadges();
      lastKnownTickets = currentTickets;
    }
  }

  const btns = findTicketButtons();
  if (btns.length === 0) return;

  widenAksiColumn();
  debugLog("[asguard-tinjut] found ticket buttons:", btns.length);

  const noTikets: string[] = [];
  const btnMap = new Map<string, HTMLElement[]>();
  for (const btn of btns) {
    const nt = btn.textContent?.trim() ?? "";
    if (!nt) continue;
    if (tinjutCache.has(nt)) {
      const cached = tinjutCache.get(nt)!;
      if (cached.status) injectBadge(btn, cached);
      else btn.setAttribute(TINJUT_ATTR, "n/a");
      continue;
    }
    if (!btnMap.has(nt)) {
      btnMap.set(nt, []);
      noTikets.push(nt);
    }
    btnMap.get(nt)!.push(btn);
  }

  if (noTikets.length === 0) return;

  for (const [, group] of btnMap) {
    for (const b of group) b.setAttribute(TINJUT_ATTR, "loading");
  }

  // Use port streaming for progressive badge rendering
  try {
    const port = chrome.runtime.connect({ name: "siman-tinjut" });

    port.onMessage.addListener((msg: {
      type: string;
      noTiket?: string;
      info?: TinjutInfo;
      error?: string;
    }) => {
      if (msg.type === "tinjut/result" && msg.noTiket && msg.info) {
        tinjutCache.set(msg.noTiket, msg.info);
        const group = btnMap.get(msg.noTiket);
        if (group) {
          for (const b of group) injectBadge(b, msg.info);
        }
      } else if (msg.type === "tinjut/skip" && msg.noTiket) {
        const empty: TinjutInfo = { status: "", lastStatus: "", lastDate: "", lastBy: "", lastRole: "", kodeStatus: "" };
        tinjutCache.set(msg.noTiket, empty);
        const group = btnMap.get(msg.noTiket);
        if (group) {
          for (const b of group) b.setAttribute(TINJUT_ATTR, "n/a");
        }
      } else if (msg.type === "tinjut/done") {
        debugLog("[asguard-tinjut] streaming done");
        port.disconnect();
      } else if (msg.type === "tinjut/error") {
        debugLog("[asguard-tinjut] error:", msg.error);
        port.disconnect();
        for (const [, group] of btnMap) {
          for (const b of group) {
            if (b.getAttribute(TINJUT_ATTR) === "loading") b.removeAttribute(TINJUT_ATTR);
          }
        }
      }
    });

    port.postMessage({ type: "check", noTikets });
  } catch (err) {
    debugLog("[asguard-tinjut] port error:", err);
    for (const [, group] of btnMap) {
      for (const b of group) b.removeAttribute(TINJUT_ATTR);
    }
  }
}

function scheduleTinjutCheck() {
  if (tinjutTimer) clearTimeout(tinjutTimer);
  tinjutTimer = setTimeout(checkAndInjectTinjut, 1200);
}

// Wait for DOM to be ready, then setup MutationObserver
// (script runs at document_start, so body may not exist yet)
function initTinjutObserver() {
  if (location.hostname !== "siman.kemenkeu.go.id") return;

  const target = document.body || document.documentElement;
  if (!target) {
    // Body not ready yet — retry
    setTimeout(initTinjutObserver, 200);
    return;
  }

  const observer = new MutationObserver(() => {
    if (isTinjutPage()) scheduleTinjutCheck();
  });
  observer.observe(target, { childList: true, subtree: true });
  debugLog("[asguard-tinjut] observer attached");

  // Initial check if already on the right page
  if (isTinjutPage()) scheduleTinjutCheck();
}

// Kick off after DOM is interactive
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTinjutObserver);
} else {
  initTinjutObserver();
}

export {};
