import * as store from "./token-store";
import * as nadine from "./nadine-client";
import { NadineHttpError, NadineNoTokenError } from "./nadine-client";
import * as llama from "./llama-client";
import * as cache from "./summary-cache";
import * as templateStore from "./template-store";
import { buildSummaryMessages, buildKlasifikasiMessages } from "@/shared/prompts";
import type {
  ApiResult,
  ArsipBerkas,
  ArsipDocType,
  ArsipGroup,
  ArsipPortMsg,
  ArsipProgressMsg,
  BgMessage,
  ChatMessage,
  LlmPortRequest,
  LlmSettings,
  LlmStreamMsg,
  MailMergeProgressMsg,
  MailMergeRowMsg,
  PanelRequest,
  PanelSnapshot,
  TemplateRunRequest,
  TemplateRunMsg,
} from "@/shared/types";
import { DEFAULT_LLM_SETTINGS } from "@/shared/types";
import * as simanStore from "./siman-store";
import * as simanClient from "./siman-client";
import type { SimanRunPortRequest, SimanRunProgressMsg } from "@/shared/siman-types";
import * as licenseClient from "./license-client";
import type { LicenseStatus } from "./license-client";

// --- Settings storage ---

const SETTINGS_KEY = "asguard.llmSettings";
let llmSettings: LlmSettings = { ...DEFAULT_LLM_SETTINGS };

// Captured penetapan body from SIMAN's own frontend requests
let _capturedPenetapanBody: Record<string, unknown> | null = null;

// License status
let _licenseStatus: LicenseStatus | null = null;

async function loadSettings(): Promise<void> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  if (data[SETTINGS_KEY]) {
    llmSettings = { ...DEFAULT_LLM_SETTINGS, ...(data[SETTINGS_KEY] as Partial<LlmSettings>) };
  }
}

async function saveSettings(partial: Partial<LlmSettings>): Promise<LlmSettings> {
  llmSettings = { ...llmSettings, ...partial };
  await chrome.storage.local.set({ [SETTINGS_KEY]: llmSettings });
  return llmSettings;
}

// --- API helper ---

async function runApi<T>(fn: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (e) {
    if (e instanceof NadineHttpError) {
      return { ok: false, error: e.message, status: e.status };
    }
    if (e instanceof NadineNoTokenError) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// --- Session keepalive via chrome.alarms ---

const KEEPALIVE_ALARM = "asguard.keepalive";

function setupKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  const { token } = store.getToken();
  if (!token) return;
  // Fire-and-forget keepalive ping
  fetch("https://service.kemenkeu.go.id/nadine-nanas/auth/now", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  }).catch(() => {});
});

// --- Init ---

chrome.runtime.onInstalled.addListener(() => {
  console.log("[asguard] installed");
  setupKeepalive();
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[asguard] setPanelBehavior failed", err));

const _ready = (async () => {
  await store.restore();
  await simanStore.restoreSimanToken();
  await loadSettings();
  setupKeepalive();
  // Restore cached license and re-check if NIP is known
  _licenseStatus = await licenseClient.restoreCachedLicense();
  const knownNip = store.getToken().nip ?? simanStore.getSimanToken().nip;
  console.log("[asguard] boot — knownNip:", JSON.stringify(knownNip), "cachedLicense:", _licenseStatus?.status ?? "none");
  if (knownNip) {
    refreshLicense(knownNip).then(() => broadcastState()).catch(() => {});
  }
})();

// --- Snapshot for panel ---

// Pending captured payload (from naskah/created interception)
let pendingPayload: Record<string, unknown> | null = null;

let _activeTab: "nadine" | "siman" = "nadine";

function resolveActiveTab(): "nadine" | "siman" {
  return _activeTab;
}

function snapshot(): PanelSnapshot {
  return {
    token: store.getToken(),
    lastPage: store.getPage(),
    currentNdId: store.getCurrentNdId(),
    pendingPayload: !!pendingPayload,
    simanToken: simanStore.getSimanToken(),
    activeTab: resolveActiveTab(),
    licenseStatus: _licenseStatus,
  };
}

async function refreshLicense(nip: string): Promise<void> {
  _licenseStatus = await licenseClient.checkLicense(nip);
  console.log("[asguard] license:", _licenseStatus.status, _licenseStatus.message);
}

function broadcastState() {
  chrome.runtime
    .sendMessage({ type: "state/changed", snapshot: snapshot() })
    .catch(() => {
      /* no panel open */
    });
}

// Enrich an auto-detected role context with display fields from the roles API.
// Called fire-and-forget after auto-detection paths that leave namaRoleStruktur/namaUnit/urKanwil empty.
async function enrichRoleContextAsync(userId: string): Promise<void> {
  const current = simanStore.getSimanToken();
  if (!current.role || !current.token) return;
  if (current.role.namaRoleStruktur && current.role.namaUnit) return; // already enriched
  try {
    const roles = await simanClient.getRoles(userId);
    const match = roles.find(r => r.id_role === current.role!.idRole)
      ?? roles.find(r => r.id_kpknl === current.role!.idKpknl)
      ?? (roles.length === 1 ? roles[0] : undefined);
    if (!match) return;
    const enriched: import("@/shared/siman-types").SimanRoleContext = {
      ...current.role,
      namaRoleStruktur: current.role.namaRoleStruktur || String(match.nama_role_struktur ?? match.nm_role ?? ""),
      nmKpknl: current.role.nmKpknl || String(match.nm_kpknl ?? match.nama_unit ?? ""),
      namaUnit: current.role.namaUnit || String(match.nama_unit ?? ""),
      nmKanwil: current.role.nmKanwil || String(match.nm_kanwil ?? match.ur_kanwil ?? ""),
      urKanwil: current.role.urKanwil || String(match.ur_kanwil ?? ""),
    };
    await simanStore.setSimanRole(enriched, current.token);
    broadcastState();
    console.log("[asguard] enriched role context:", enriched.namaRoleStruktur, enriched.namaUnit);
  } catch (e) {
    console.warn("[asguard] enrichRoleContextAsync failed:", e);
  }
}

// --- Message handlers (request/response) ---

chrome.runtime.onMessage.addListener(
  (raw: BgMessage | PanelRequest, _sender, sendResponse) => {
    (async () => {
      await _ready;
      // Content script messages
      if (raw.type === "token/capture") {
        const changed = await store.setToken(raw.token, raw.origin);
        if (changed) {
          console.log("[asguard] token captured from", new URL(raw.origin).hostname);
          broadcastState();
          // Fire-and-forget: extract NIP from JWT or /Auth/me, then check license
          (async () => {
            try {
              // Fast path: try JWT payload first
              const payload = simanClient.decodeJwtPayload(raw.token);
              const nipJwt = String(payload.nip ?? payload.username ?? "").trim();
              if (/^\d{9,18}$/.test(nipJwt)) {
                await store.setNipFromMe(nipJwt, String(payload.fullname ?? payload.nama ?? ""));
                await refreshLicense(nipJwt);
                broadcastState();
                return;
              }
              // Slow path: /Auth/me
              const me = await nadine.getAuthMe();
              const d = ((me as Record<string, unknown>).Data ?? {}) as Record<string, unknown>;
              const nip = String(d.Nip ?? d.nip ?? "").trim();
              const fullname = String(d.Nama ?? d.nama ?? d.Name ?? "").trim();
              if (/^\d{9,18}$/.test(nip)) {
                await store.setNipFromMe(nip, fullname);
                await refreshLicense(nip);
                broadcastState();
              }
            } catch (e) {
              console.warn("[asguard] NIP fetch failed:", e);
            }
          })();
        }
        sendResponse({ ok: true });
        return;
      }
      if (raw.type === "page/changed") {
        await store.setPage(raw.ctx);
        if (raw.ctx.page.kind === "siman") _activeTab = "siman";
        else if (raw.ctx.page.kind !== "other") _activeTab = "nadine";
        broadcastState();
        sendResponse({ ok: true });
        return;
      }
      if (raw.type === "viewing/ndId") {
        const changed = await store.setCurrentNdId(raw.ndId);
        if (changed) broadcastState();
        sendResponse({ ok: true });
        return;
      }
      if (raw.type === "pdf/captured") {
        // Store captured PDF data, keyed by current ndId
        const currentNdId = store.getCurrentNdId();
        if (currentNdId) {
          capturedPdfs.set(currentNdId, {
            base64: raw.base64,
            url: raw.url,
            capturedAt: Date.now(),
          });
          console.log(`[asguard] stored captured PDF for ndId=${currentNdId} (${raw.size} bytes from ${raw.url.slice(-60)})`);
        } else {
          // No ndId yet — store with a temp key and re-associate later
          capturedPdfs.set("__latest__", {
            base64: raw.base64,
            url: raw.url,
            capturedAt: Date.now(),
          });
          console.log(`[asguard] stored captured PDF (no ndId yet, ${raw.size} bytes)`);
        }
        sendResponse({ ok: true });
        return;
      }

      // Captured create-naskah payload
      if (raw.type === "naskah/created") {
        pendingPayload = raw.payload;
        console.log("[asguard] captured CreateNaskahPayload, notifying sidepanel");
        broadcastState();
        sendResponse({ ok: true });
        return;
      }

      if (raw.type === "siman/token") {
        const payload = simanClient.decodeJwtPayload(raw.token);
        // Check top-level AND nested `.data` object (common in govt JWTs)
        const nested = (typeof payload.data === "object" && payload.data !== null)
          ? payload.data as Record<string, unknown>
          : {} as Record<string, unknown>;
        console.log("[asguard] SIMAN JWT payload:", JSON.stringify(payload));
        const userIdFromJwt = String(
          payload.sid ?? nested.sid ??
          payload.uid ?? nested.uid ??
          payload.user_id ?? nested.user_id ??
          payload.sub ?? nested.sub ??
          payload.id_user_detail ?? nested.id_user_detail ??
          payload.id_user ?? nested.id_user ??
          payload.userId ?? nested.userId ??
          payload.id ?? nested.id ??
          payload.username ?? nested.username ??
          payload.nip ?? nested.nip ??
          payload.nik ?? nested.nik ??
          "",
        );
        if (!userIdFromJwt) {
          console.warn("[asguard] SIMAN JWT — could not extract userId, will try /me");
        }

        // Fetch user profile from SIMAN /me — primary source for id_user (matches CLI behaviour)
        let userMeta: Record<string, string> = { nip: "", fullname: "", jabatan: "", idUser: "" };
        try {
          const meRes = await fetch("https://siman-svc.kemenkeu.go.id/swkf/auth/v1/me", {
            headers: {
              Authorization: `Bearer ${raw.token}`,
              Accept: "application/json",
              Origin: "https://siman.kemenkeu.go.id",
              Referer: "https://siman.kemenkeu.go.id/",
            },
          });
          if (meRes.ok) {
            const me = await meRes.json() as Record<string, unknown>;
            const d = (me.data ?? me) as Record<string, unknown>;
            console.log("[asguard] SIMAN /me full response keys:", Object.keys(d));
            userMeta = {
              // id_user from /me is the authoritative user id (matches CLI auth.py)
              idUser: String(d.id_user ?? d.id ?? ""),
              nip: String(d.nip ?? d.username ?? payload.nip ?? payload.username ?? ""),
              fullname: String(d.fullname ?? d.nama ?? d.name ?? ""),
              jabatan: String(d.jabatan ?? d.jabatan_pengguna ?? ""),
              idKpknl: String(d.id_kpknl ?? d.kd_kpknl ?? "0"),
              idKanwil: String(d.id_kanwil ?? d.kd_kanwil ?? "0"),
              idRole: String(d.id_role ?? ""),
              idStruktur: String(d.id_struktur ?? d.id_struktur_termohon ?? "9"),
            };
            console.log("[asguard] SIMAN /me profile:", userMeta);
          }
        } catch (e) {
          console.warn("[asguard] SIMAN /me failed:", e);
        }

        // Use /me id_user as primary; fall back to JWT-extracted id
        const userId = userMeta.idUser || userIdFromJwt;
        if (!userId) {
          console.warn("[asguard] SIMAN: no userId from JWT or /me — storing token without userId");
        }

        const changed = await simanStore.setSimanToken(raw.token, {
          userId,
          nip: (userMeta as Record<string,string>).nip || String(payload.nip ?? payload.username ?? ""),
          fullname: (userMeta as Record<string,string>).fullname || String(payload.fullname ?? payload.name ?? payload.nama ?? ""),
          jabatan: (userMeta as Record<string,string>).jabatan || String(payload.jabatan ?? payload.jabatan_pengguna ?? ""),
        });

        // Fetch role context if: (a) no role yet, or (b) kpknl is still "0" (stale minimal context)
        const tokenType = String(payload.t ?? "");
        const currentState = simanStore.getSimanToken();
        const needsRoleFetch = tokenType === "R" && (
          !currentState.role || currentState.role.idKpknl === "0"
        );
        if (needsRoleFetch) {
          const uidFromJwt = String(payload.uid ?? "");
          // Try kpknl from /me first (most reliable with role token)
          const meKpknl = (userMeta as Record<string,string>).idKpknl ?? "0";
          const meKanwil = (userMeta as Record<string,string>).idKanwil ?? "0";
          const meRole = (userMeta as Record<string,string>).idRole ?? "";
          const meStruktur = (userMeta as Record<string,string>).idStruktur ?? "9";

          if (meKpknl !== "0") {
            // /me returned kpknl — use it directly
            const roleContext: import("@/shared/siman-types").SimanRoleContext = {
              idUserDetail: uidFromJwt,
              idUser: userId,
              idRole: meRole || "1",
              nmRole: (userMeta as Record<string,string>).jabatan || "Auto",
              namaRoleStruktur: "",
              idKpknl: meKpknl,
              nmKpknl: "",
              namaUnit: "",
              idKanwil: meKanwil,
              nmKanwil: "",
              urKanwil: "",
              idStruktur: meStruktur,
              token: raw.token,
            };
            await simanStore.setSimanRole(roleContext, raw.token);
            enrichRoleContextAsync(userId).catch(() => {});
            console.log("[asguard] SIMAN role from /me: kpknl=", meKpknl);
          } else {
            // /me had no kpknl — try user-detail-filter with the UUID uid
            try {
              const filterArr = uidFromJwt ? await simanClient.getRoleFilter(uidFromJwt) : [];
              const fd = (filterArr[0] ?? {}) as Record<string, unknown>;
              console.log("[asguard] user-detail-filter result:", JSON.stringify(fd));
              const roleContext: import("@/shared/siman-types").SimanRoleContext = {
                idUserDetail: uidFromJwt || String(fd.id_user_detail ?? ""),
                idUser: userId,
                idRole: String(fd.id_role ?? "1"),
                nmRole: String(fd.nm_role ?? (userMeta as Record<string,string>).jabatan ?? "Auto"),
                namaRoleStruktur: "",
                idKpknl: String(fd.id_kpknl ?? "0"),
                nmKpknl: String(fd.nm_kpknl ?? ""),
                namaUnit: "",
                idKanwil: String(fd.id_kanwil ?? "0"),
                nmKanwil: String(fd.nm_kanwil ?? ""),
                urKanwil: "",
                idStruktur: String(fd.id_struktur ?? fd.id_struktur_termohon ?? "9"),
                token: raw.token,
              };
              await simanStore.setSimanRole(roleContext, raw.token);
              enrichRoleContextAsync(userId).catch(() => {});
              console.log("[asguard] SIMAN role from user-detail-filter: kpknl=", roleContext.idKpknl);
            } catch (e) {
              console.warn("[asguard] user-detail-filter failed:", e);
              // Minimal fallback — at least skip the picker
              const roleContext: import("@/shared/siman-types").SimanRoleContext = {
                idUserDetail: uidFromJwt,
                idUser: userId,
                idRole: "1",
                nmRole: (userMeta as Record<string,string>).jabatan || "Auto",
                namaRoleStruktur: "",
                idKpknl: "0",
                nmKpknl: "",
                namaUnit: "",
                idKanwil: "0",
                nmKanwil: "",
                urKanwil: "",
                idStruktur: "9",
                token: raw.token,
              };
              await simanStore.setSimanRole(roleContext, raw.token);
              enrichRoleContextAsync(userId).catch(() => {});
            }
          }
        }

        if (changed || tokenType === "R") {
          console.log("[asguard] SIMAN token captured from", new URL(raw.origin).hostname);
          _activeTab = "siman";
          broadcastState();
        }
        // Always attempt license check on every SIMAN token message (fire-and-forget)
        const simanNip = simanStore.getSimanToken().nip ?? "";
        console.log("[asguard] SIMAN NIP for license:", JSON.stringify(simanNip));
        if (/^\d{9,18}$/.test(simanNip)) {
          if (!_licenseStatus || _licenseStatus.status === "offline" || _licenseStatus.status === "error") {
            refreshLicense(simanNip).then(() => broadcastState()).catch(() => {});
          }
        }
        sendResponse({ ok: true });
        return;
      }


      // Auto-set role context from intercepted SIMAN web traffic
      if (raw.type === "siman/role-data") {
        const rd = raw.roleData;
        console.log("[asguard] siman/role-data received:", JSON.stringify(rd).slice(0, 500));
        const currentState = simanStore.getSimanToken();
        if (!currentState.token) {
          sendResponse({ ok: false, error: "No SIMAN token yet" });
          return;
        }

        // Case 1: jwt-roles response (contains token + role data)
        if (rd.token && typeof rd.token === "string") {
          const rolePayload = simanClient.decodeJwtPayload(rd.token as string);
          const roleContext: import("@/shared/siman-types").SimanRoleContext = {
            idUserDetail: String(currentState.userId ?? ""),
            idUser: String(currentState.userId ?? ""),
            idRole: String(rd.id_role ?? rolePayload.id_role ?? ""),
            nmRole: String(rd.nm_role ?? rolePayload.nm_role ?? "auto"),
            namaRoleStruktur: String(rd.nama_role_struktur ?? ""),
            idKpknl: String(rd.id_kpknl ?? rolePayload.id_kpknl ?? "0"),
            nmKpknl: String(rd.nm_kpknl ?? rolePayload.nm_kpknl ?? ""),
            namaUnit: String(rd.nama_unit ?? ""),
            idKanwil: String(rd.id_kanwil ?? rolePayload.id_kanwil ?? "0"),
            nmKanwil: String(rd.nm_kanwil ?? rolePayload.nm_kanwil ?? ""),
            urKanwil: String(rd.ur_kanwil ?? ""),
            idStruktur: "9",
            token: rd.token as string,
          };
          await simanStore.setSimanRole(roleContext, rd.token as string);
          console.log("[asguard] auto-set SIMAN role from jwt-roles interception:", roleContext.nmRole);
          broadcastState();
          sendResponse({ ok: true });
          return;
        }

        // Case 2: Array of roles — if only one, auto-pick it
        if (Array.isArray(rd.roles) && rd.roles.length > 0) {
          const roles = rd.roles as Record<string, unknown>[];
          // Try to auto-select: use first role (or the active one)
          const activeRole = roles[0];
          // We have role info but need to set it via the API flow
          // Store the roles info so background can auto-select
          try {
            const role: import("@/shared/siman-types").SimanRole = {
              id_role: String(activeRole.id_role ?? ""),
              nm_role: String(activeRole.nm_role ?? ""),
              id_kpknl: String(activeRole.id_kpknl ?? ""),
              nm_kpknl: String(activeRole.nm_kpknl ?? ""),
              id_kanwil: String(activeRole.id_kanwil ?? ""),
              nm_kanwil: String(activeRole.nm_kanwil ?? ""),
              id_user: String(activeRole.id_user ?? currentState.userId ?? ""),
              id_user_detail: String(activeRole.id_user_detail ?? ""),
              id_struktur: String(activeRole.id_struktur ?? ""),
              id_role_struktur: String(activeRole.id_role_struktur ?? activeRole.id_role ?? ""),
            };
            const idUserDetail = String(activeRole.id_user_detail ?? currentState.userId ?? "");
            const filterData = await simanClient.getRoleFilter(idUserDetail);
            const { token, context } = await simanClient.setRole(role, filterData, currentState.fullname ?? "");
            await simanStore.setSimanRole(context, token);
            console.log("[asguard] auto-set SIMAN role from intercepted roles list:", role.nm_role);
            broadcastState();
          } catch (e) {
            console.warn("[asguard] auto-set role failed:", e);
          }
          sendResponse({ ok: true });
          return;
        }

        // Case 3: Filter data (kpknl/kanwil) — enrich existing role or create minimal role
        if (rd.filterData && typeof rd.filterData === "object") {
          const fd = rd.filterData as Record<string, unknown>;
          if (!currentState.role && (fd.id_kpknl || fd.id_kanwil)) {
            const roleContext: import("@/shared/siman-types").SimanRoleContext = {
              idUserDetail: String(fd.id_user_detail ?? currentState.userId ?? ""),
              idUser: String(fd.id_user ?? currentState.userId ?? ""),
              idRole: String(fd.id_role ?? ""),
              nmRole: String(fd.nm_role ?? "auto"),
              namaRoleStruktur: String(fd.nama_role_struktur ?? ""),
              idKpknl: String(fd.id_kpknl ?? "0"),
              nmKpknl: String(fd.nm_kpknl ?? ""),
              namaUnit: String(fd.nama_unit ?? ""),
              idKanwil: String(fd.id_kanwil ?? "0"),
              nmKanwil: String(fd.nm_kanwil ?? ""),
              urKanwil: String(fd.ur_kanwil ?? ""),
              idStruktur: String(fd.id_struktur ?? "9"),
              token: currentState.token!,
            };
            await simanStore.setSimanRole(roleContext, currentState.token!);
            console.log("[asguard] auto-set SIMAN role from filter data");
            broadcastState();
          }
          sendResponse({ ok: true });
          return;
        }

        // Case 4: Direct role data from localStorage
        if (rd.id_kpknl || rd.id_kanwil || rd.id_role) {
          if (!currentState.role) {
            const roleContext: import("@/shared/siman-types").SimanRoleContext = {
              idUserDetail: String(rd.id_user_detail ?? currentState.userId ?? ""),
              idUser: String(rd.id_user ?? currentState.userId ?? ""),
              idRole: String(rd.id_role ?? ""),
              nmRole: String(rd.nm_role ?? "auto"),
              namaRoleStruktur: String(rd.nama_role_struktur ?? ""),
              idKpknl: String(rd.id_kpknl ?? "0"),
              nmKpknl: String(rd.nm_kpknl ?? ""),
              namaUnit: String(rd.nama_unit ?? ""),
              idKanwil: String(rd.id_kanwil ?? "0"),
              nmKanwil: String(rd.nm_kanwil ?? ""),
              urKanwil: String(rd.ur_kanwil ?? ""),
              idStruktur: "9",
              token: currentState.token!,
            };
            await simanStore.setSimanRole(roleContext, currentState.token!);
            console.log("[asguard] auto-set SIMAN role from localStorage data");
            broadcastState();
          }
          sendResponse({ ok: true });
          return;
        }

        sendResponse({ ok: true });
        return;
      }

      // Panel requests
      if (raw.type === "state/get") {
        sendResponse(snapshot());
        return;
      }
      if (raw.type === "token/clear") {
        await store.clearToken();
        sendResponse(snapshot());
        return;
      }
      if (raw.type === "api/counts") {
        sendResponse(await runApi(() => nadine.getCounts()));
        return;
      }
      if (raw.type === "api/naskah") {
        sendResponse(await runApi(() => nadine.getNaskahDetail(raw.ndId)));
        return;
      }
      if (raw.type === "settings/get") {
        sendResponse({ ok: true, data: llmSettings });
        return;
      }
      if (raw.type === "settings/set") {
        const updated = await saveSettings(raw.settings);
        sendResponse({ ok: true, data: updated });
        return;
      }
      if (raw.type === "llm/health") {
        const healthy = await llama.checkHealth(llmSettings.llamaUrl);
        sendResponse({ ok: true, data: healthy });
        return;
      }
      if (raw.type === "cache/clear") {
        await cache.clearCache();
        sendResponse({ ok: true });
        return;
      }

      // --- Template CRUD ---
      if (raw.type === "template/list") {
        sendResponse({ ok: true, data: await templateStore.getAll() });
        return;
      }
      if (raw.type === "template/get") {
        const t = await templateStore.getById(raw.id);
        sendResponse(t ? { ok: true, data: t } : { ok: false, error: "Not found" });
        return;
      }
      if (raw.type === "template/save") {
        const saved = await templateStore.save(raw.template);
        pendingPayload = null;
        broadcastState();
        sendResponse({ ok: true, data: saved });
        return;
      }
      if (raw.type === "template/update") {
        const updated = await templateStore.update(raw.id, raw.updates);
        sendResponse(updated ? { ok: true, data: updated } : { ok: false, error: "Not found" });
        return;
      }
      if (raw.type === "template/delete") {
        const deleted = await templateStore.remove(raw.id);
        sendResponse({ ok: true, data: deleted });
        return;
      }
      if (raw.type === "template/pending") {
        sendResponse({ ok: true, data: pendingPayload });
        return;
      }
      // --- Arsiparis ---
      if (raw.type === "arsip/fetch") {
        sendResponse(await runApi(async () => {
          const { docType, startDate, endDate, perihal, limit } = raw;
          let res: { Data?: unknown[] };
          if (docType === "konsep") res = await nadine.getArsipUnitUnarchived({ limit, startDate, endDate, perihal });
          else if (docType === "amplop") res = await nadine.getArsipAmplopUnarchived({ limit, startDate, endDate, perihal });
          else res = await nadine.getArsipDisposisiUnarchived({ limit, startDate, endDate, perihal });
          return res.Data ?? [];
        }));
        return;
      }
      if (raw.type === "arsip/berkas-list") {
        sendResponse(await runApi(async () => {
          const res = await nadine.getListBerkas();
          return res.Data ?? [];
        }));
        return;
      }
      if (raw.type === "arsip/berkas-create") {
        sendResponse(await runApi(() => nadine.createBerkas({
          KlasifikasiArsipId: raw.klasifikasiArsipId,
          UraianBerkas: raw.uraianBerkas,
          KurunWaktu: raw.kurunWaktu,
        })));
        return;
      }
      if (raw.type === "arsip/klasifikasi-fav") {
        sendResponse(await runApi(async () => {
          const res = await nadine.getRefKlasifikasiArsipFav();
          return res.Data ?? [];
        }));
        return;
      }
      if (raw.type === "arsip/klasifikasi-all") {
        sendResponse(await runApi(async () => {
          const res = await nadine.getRefKlasifikasiArsipAll();
          return res.Data ?? [];
        }));
        return;
      }
      if (raw.type === "arsip/bulk") {
        sendResponse(await runApi(() => nadine.berkaskanMultiple(raw.docType, raw.berkasId, raw.items)));
        return;
      }

      // Fetch subordinate org units for NP penandatangan picker
      if (raw.type === "template/units") {
        try {
          // kodeOrganisasi must come from the current user's CurrentUnit (same as Python CLI)
          // The pengirim payload field names vary — /Auth/me is the reliable source
          const authMe = await nadine.getAuthMe();
          const kodeOrg = authMe.Data?.CurrentUnit?.KodeOrganisasi ?? (raw.kodeOrganisasi as string | undefined) ?? "";
          console.log(`[asguard] template/units: kodeOrg=${kodeOrg} (from Auth/me)`);

          if (!kodeOrg) {
            sendResponse({ ok: false, error: "KodeOrganisasi tidak tersedia dari Auth/me" });
            return;
          }

          const tree = await nadine.getRefUnitsTree(kodeOrg);
          const allUnits = (tree.Data ?? []) as Record<string, unknown>[];
          const pengirimEselon = raw.pengirimEselon as number;
          const targetEselon = pengirimEselon + 1;
          const preferred = allUnits.filter(u => (u.Eselon as number | undefined) === targetEselon);
          const fallback = allUnits.filter(u => {
            const ue = u.Eselon as number | undefined;
            return ue !== undefined && ue > pengirimEselon && ue !== targetEselon;
          });
          const units = [...preferred, ...fallback].slice(0, 15);
          console.log(`[asguard] template/units: ${allUnits.length} total, ${units.length} filtered (target eselon ${targetEselon})`);
          sendResponse({ ok: true, data: units });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      // --- SIMAN panel requests ---
      if (raw.type === "siman/state") {
        sendResponse(snapshot());
        return;
      }
      if (raw.type === "siman/token-clear") {
        await simanStore.clearSimanToken();
        _capturedPenetapanBody = null;
        broadcastState();
        sendResponse(snapshot());
        return;
      }
      if (raw.type === "siman/penetapan-body") {
        _capturedPenetapanBody = raw.body as Record<string, unknown>;
        console.log("[asguard] stored captured penetapan body, kpknl:", _capturedPenetapanBody.filter_id);
        sendResponse({ ok: true });
        return;
      }
      if (raw.type === "siman/get-roles") {
        const { userId } = simanStore.getSimanToken();
        if (!userId) { sendResponse({ ok: false, error: "No SIMAN token" }); return; }
        try {
          const roles = await simanClient.getRoles(userId);
          sendResponse({ ok: true, data: roles });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (raw.type === "siman/set-role") {
        const { fullname, userId } = simanStore.getSimanToken();
        if (!userId) { sendResponse({ ok: false, error: "No SIMAN token" }); return; }
        try {
          // Use id_user_detail from the role itself (different from login userId/sid)
          const idUserDetail = String(raw.role.id_user_detail ?? userId ?? "");
          const filterData = await simanClient.getRoleFilter(idUserDetail);
          const { token, context } = await simanClient.setRole(raw.role, filterData, fullname ?? "");
          await simanStore.setSimanRole(context, token);
          broadcastState();
          sendResponse(snapshot());
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (raw.type === "siman/get-tipe-pengelolaan") {
        try {
          const data = await simanClient.getTipePengelolaan();
          sendResponse({ ok: true, data });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (raw.type === "siman/get-penetapan-list") {
        const { role } = simanStore.getSimanToken();
        if (!role) { sendResponse({ ok: false, error: "No SIMAN role selected" }); return; }
        console.log("[asguard] penetapan role context:", JSON.stringify(role));
        console.log("[asguard] captured body available:", !!_capturedPenetapanBody);
        try {
          const data = await simanClient.getPenetapanList(
            role, raw.limit, raw.offset, raw.statusFilter, raw.idTipe,
            _capturedPenetapanBody ?? undefined,
          );
          sendResponse({ ok: true, data });
        } catch (e) {
          console.error("[asguard] penetapan error:", e);
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (raw.type === "siman/get-penetapan-detail") {
        try {
          // API takes { id_pengelolaan } despite endpoint name "by-no-tiket"
          const id = (raw as Record<string, unknown>).idPengelolaan as string ?? raw.noTiket;
          const data = await simanClient.getPermohonanDetail(id);
          sendResponse({ ok: true, data });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (raw.type === "siman/get-templates") {
        sendResponse({ ok: true, data: await simanStore.getAllSimanTemplates() });
        return;
      }
      if (raw.type === "siman/save-template") {
        sendResponse({ ok: true, data: await simanStore.saveSimanTemplate(raw.template) });
        return;
      }
      if (raw.type === "siman/template-update") {
        sendResponse({ ok: true, data: await simanStore.updateSimanTemplate(raw.id, raw.updates) });
        return;
      }
      if (raw.type === "siman/delete-template") {
        sendResponse({ ok: true, data: await simanStore.deleteSimanTemplate(raw.id) });
        return;
      }

      if (raw.type === "license/check") {
        const nip = store.getToken().nip ?? simanStore.getSimanToken().nip;
        if (!nip) {
          sendResponse({ ok: false, error: "NIP tidak diketahui" });
          return;
        }
        await refreshLicense(nip);
        broadcastState();
        sendResponse({ ok: true, data: _licenseStatus });
        return;
      }

      if (raw.type === "license/clear-cache") {
        await licenseClient.clearLicenseCache();
        _licenseStatus = null;
        broadcastState();
        sendResponse({ ok: true });
        return;
      }
    })();
    return true; // keep channel open for async
  },
);

// --- Port-based streaming for LLM summary + chat ---

// In-memory cache of extracted naskah text for chat follow-ups
const naskahTextCache = new Map<string, { body: string; meta: Record<string, string | undefined> }>();

// Captured PDF data from the page's own network requests
// Key: ndId, Value: { base64, url, capturedAt }
const capturedPdfs = new Map<string, { base64: string; url: string; capturedAt: number }>();

chrome.runtime.onConnect.addListener((port) => {
  // Template-run port
  if (port.name === "template-run") {
    port.onMessage.addListener((msg: TemplateRunRequest) => {
      if (msg.type === "template/run") handleTemplateRun(port, msg);
    });
    return;
  }

  // Mail-merge port
  if (port.name === "mail-merge-run") {
    handleMailMergeRun(port);
    return;
  }

  // Arsiparis port
  if (port.name === "arsip-run") {
    handleArsipRun(port);
    return;
  }

  if (port.name === "siman-run") {
    port.onMessage.addListener(async (msg: SimanRunPortRequest) => {
      function send(m: SimanRunProgressMsg) {
        try { port.postMessage(m); } catch { /* port closed */ }
      }

      if (msg.type === "siman/run") {
        const { role } = simanStore.getSimanToken();
        if (!role) {
          send({ step: "error", status: "error", message: "No SIMAN role selected" });
          return;
        }
        const template = await simanStore.getSimanTemplateById(msg.templateId);
        if (!template) {
          send({ step: "error", status: "error", message: "Template tidak ditemukan" });
          return;
        }
        try {
          send({ step: "Mengambil data permohonan…", status: "running" });
          const variables = await simanClient.buildVariableMap(
            role, msg.idPengelolaan, msg.idTipePengelolaan,
          );
          const merged: Record<string, string> = { ...variables };
          // savedVariables only applied when savedKdSatker is set AND matches current ticket's kd_satker.
          // No savedKdSatker (template never run since fix) = skip — prevents cross-satker bleed.
          // Within same satker, only fills keys NOT returned by SIMAN API — API data always wins.
          const sameSatker = !!template.savedKdSatker && template.savedKdSatker === variables.kd_satker;
          if (sameSatker) {
            for (const [k, v] of Object.entries(template.savedVariables)) {
              if (v && !variables[k]) merged[k] = v;
            }
          }
          // Custom var output keys are computed client-side — mark them non-empty so they're never "missing"
          const customVarKeys = new Set(
            (template.customVars ?? []).map((cv: { outputKey: string }) => cv.outputKey).filter(Boolean),
          );
          for (const key of customVarKeys) {
            if (!merged[key as string]) merged[key as string] = "__custom__";
          }
          // __ask__ placeholders: clear only when SIMAN API didn't provide the value.
          // If API already has it (e.g. perihal_sk from SK data), keep the fresh API value.
          // If API has nothing, force empty so the user is always prompted for truly unknown vars.
          for (const [ph, varKey] of Object.entries(template.mapping)) {
            if (varKey === "__ask__") {
              const effectiveKey = ph.replace(/^\{|\}$/g, "");
              if (!variables[effectiveKey]) merged[effectiveKey] = "";
            }
          }
          const missing = Object.entries(template.mapping)
            .map(([ph, varKey]) => varKey === "__ask__" ? ph.replace(/^\{|\}$/g, "") : varKey)
            .filter((key) => !merged[key] || merged[key] === "");
          // Remove __custom__ sentinels — client will compute real values from customVars
          for (const key of customVarKeys) {
            if (merged[key as string] === "__custom__") delete merged[key as string];
          }
          send({ step: "variables", status: "done", variables: merged, message: missing.join(",") });
        } catch (e) {
          send({ step: "error", status: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }

      /** Step 1+2 of CLI: get konsep detail → generateEditLink → 1s delay before upload */
      async function prepareNDForUpload(ndId: number): Promise<{ docId: string | null; editPayload: Record<string, unknown> }> {
        let docId: string | null = null;
        let editPayload: Record<string, unknown> = {};
        // Try "Konsep" first (mirrors Python CLI) — returns edit payload with Pengirim/Tujuan/Id
        // Fallback to "" then "KonsepNaskah" if docId not found
        for (const tipedata of ["Konsep", "", "KonsepNaskah"]) {
          try {
            const detail = await nadine.getNaskahDetail(ndId, tipedata);
            const d = ((detail as { Data?: unknown }).Data as Record<string, unknown>) ?? {};
            const raw = String(d.Id ?? d.id ?? "");
            if (raw && raw !== "undefined" && raw !== "null") {
              docId = raw;
              editPayload = d;
              break;
            }
          } catch { /* try next tipedata */ }
        }

        if (docId) {
          for (let retry = 0; retry < 5; retry++) {
            try {
              const res = await nadine.generateEditLink(ndId, docId, editPayload);
              if ((res as { Success?: boolean }).Success) break;
            } catch { /* retry */ }
            if (retry < 4) await new Promise<void>((r) => setTimeout(r, 2000));
          }
          await new Promise<void>((r) => setTimeout(r, 1000));
        }

        return { docId, editPayload };
      }

      /** Upload ND docx with 5-retry logic, mirroring CLI */
      async function uploadNDWithRetry(ndId: number, filename: string, bytes: Uint8Array): Promise<void> {
        let lastErr: unknown;
        for (let retry = 0; retry < 5; retry++) {
          if (retry > 0) await new Promise<void>((r) => setTimeout(r, 2000));
          try {
            const res = await nadine.uploadKonsepFile(ndId, filename, bytes);
            if ((res as { Success?: boolean }).Success !== false) return;
          } catch (e) { lastErr = e; }
        }
        throw lastErr ?? new Error("Upload ND gagal setelah 5 percobaan");
      }

      function nadineErrMsg(e: unknown): string {
        if (e && typeof e === "object" && "body" in e && "message" in e) {
          const body = String((e as Record<string, unknown>).body ?? "");
          const msg = String((e as Record<string, unknown>).message ?? "");
          return `${msg}${body ? ` — ${body.slice(0, 200)}` : ""}`;
        }
        return e instanceof Error ? e.message : String(e);
      }

      /** Full NP create + upload flow, mirroring the working template run */
      async function handleNPUpload(
        ndId: number,
        perihal: string,
        npDocxBase64: string,
        npFilename: string,
        penandatanganUnit: Record<string, unknown>,
        templateId: string,
        editPayload: Record<string, unknown>,
      ): Promise<void> {
        // Check if NP already exists
        let npId: string | null = null;
        try {
          const npResponse = await nadine.getNotaPengantar(ndId);
          const npRaw = (npResponse as { Data?: unknown }).Data;
          const npData = Array.isArray(npRaw) ? npRaw[0] : npRaw;
          npId = ((npData as Record<string, unknown> | undefined)?.Id as string | undefined) ?? null;
        } catch { /* no existing NP */ }

        if (!npId) {
          // Derive Tujuan from edit payload (mirrors Python CLI siman/menu.py):
          // editPayload.Tujuan → TujuanInternal → Pengirim (sender of the naskah)
          const pengirim = (editPayload.Pengirim as Record<string, unknown>) ?? {};
          const tujuan = ((editPayload.Tujuan ?? editPayload.TujuanInternal ?? pengirim) as Record<string, unknown>);

          // Save penandatanganUnit to template for future runs
          await simanStore.updateSimanTemplate(templateId, { npPenandatangan: penandatanganUnit });

          const npPayload = {
            Perihal: perihal,
            Penandatangan: [penandatanganUnit],
            Pengirim: penandatanganUnit,
            Tujuan: tujuan,
          };

          console.log("[asguard] SIMAN NP payload:", JSON.stringify(npPayload).slice(0, 400));
          send({ step: "Membuat Nota Pengantar…", status: "running" });
          try {
            const createResp = await nadine.createNotaPengantar(ndId, npPayload);
            console.log("[asguard] SIMAN NP create response:", JSON.stringify(createResp).slice(0, 200));
          } catch (e) {
            console.warn("[asguard] createNotaPengantar warn:", nadineErrMsg(e));
          }

          // Poll NP ID — 15 × 3s = 45s timeout (mirrors CLI)
          for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise<void>((r) => setTimeout(r, 3000));
            try {
              const npResponse = await nadine.getNotaPengantar(ndId);
              const npRaw = (npResponse as { Data?: unknown }).Data;
              const npData = Array.isArray(npRaw) ? npRaw[0] : npRaw;
              npId = ((npData as Record<string, unknown> | undefined)?.Id as string | undefined) ?? null;
              if (npId) break;
            } catch { /* retry */ }
          }
        }

        if (!npId) throw new Error("Nota Pengantar gagal dibuat: ID tidak muncul dalam 45s");
        send({ step: "Mengunggah Nota Pengantar…", status: "running" });
        const npBytes = Uint8Array.from(atob(npDocxBase64), (c) => c.charCodeAt(0));
        await nadine.uploadNotaPengantarFile(ndId, npId, npFilename, npBytes);
      }

      if (msg.type === "siman/upload-nd") {
        try {
          send({ step: "Menyiapkan dokumen…", status: "running" });
          const { docId, editPayload } = await prepareNDForUpload(msg.ndId);

          send({ step: "Mengunggah konsep ND…", status: "running" });
          const ndBytes = Uint8Array.from(atob(msg.ndDocxBase64), (c) => c.charCodeAt(0));
          await uploadNDWithRetry(msg.ndId, msg.ndFilename, ndBytes);

          if (docId) {
            send({ step: "Sync dokumen…", status: "running" });
            await new Promise<void>((r) => setTimeout(r, 2000));
            for (let i = 0; i < 5; i++) {
              try { await nadine.syncDocKonsep(msg.ndId, docId); break; } catch { if (i < 4) await new Promise<void>((r) => setTimeout(r, i === 0 ? 2000 : 3000)); }
            }
          }

          console.log(`[asguard] upload-nd NP check: npDocx=${!!msg.npDocxBase64} npFile=${!!msg.npFilename} npPenandatangan=${JSON.stringify(msg.npPenandatangan)?.slice(0, 80)}`);
          if (msg.npDocxBase64 && msg.npFilename && msg.npPenandatangan) {
            const perihal = String(msg.variables.perihal_sk || msg.variables.deskripsi || msg.variables.nama_tipe_pengelolaan || "");
            await handleNPUpload(msg.ndId, perihal, msg.npDocxBase64, msg.npFilename, msg.npPenandatangan, msg.templateId, editPayload);
          }

          await simanStore.updateSimanTemplate(msg.templateId, { savedVariables: msg.variables, savedKdSatker: msg.variables.kd_satker ?? "" });
          send({ step: "done", status: "done", ndId: msg.ndId });
        } catch (e) {
          send({ step: "error", status: "error", message: nadineErrMsg(e) });
        }
      }

      if (msg.type === "siman/run-render") {
        try {
          const template = await simanStore.getSimanTemplateById(msg.templateId);
          const basePayload = (template?.nadinePayload ?? {}) as Record<string, unknown>;

          // Perihal: cascade through available sources, never block on empty
          const perihalKey = template?.perihalVarKey ?? "perihal_sk";
          const perihal = String(
            msg.variables[perihalKey] ||
            msg.variables.perihal_sk ||
            msg.variables.deskripsi ||
            msg.variables.nama_tipe_pengelolaan ||
            basePayload.Perihal ||
            msg.variables.no_tiket ||
            "",
          );
          const payload = { ...basePayload, Perihal: perihal };

          send({ step: "Membuat naskah di Nadine…", status: "running" });
          const result = await nadine.createNaskah(payload);
          if (!result.Success) {
            send({ step: "error", status: "error", message: result.Error || result.Message || "Gagal membuat naskah" });
            return;
          }
          const ndId = result.Data?.KonsepNaskah?.DataNd?.NdId;
          if (!ndId) {
            send({ step: "error", status: "error", message: "NdId tidak ditemukan dalam response" });
            return;
          }

          send({ step: "Menyiapkan dokumen…", status: "running" });
          const { docId: ndDocId, editPayload: ndEditPayload } = await prepareNDForUpload(ndId);

          send({ step: "Mengunggah konsep ND…", status: "running" });
          const ndBytes = Uint8Array.from(atob(msg.ndDocxBase64), (c) => c.charCodeAt(0));
          await uploadNDWithRetry(ndId, msg.ndFilename, ndBytes);

          if (ndDocId) {
            send({ step: "Sync dokumen…", status: "running" });
            await new Promise<void>((r) => setTimeout(r, 2000));
            for (let i = 0; i < 5; i++) {
              try { await nadine.syncDocKonsep(ndId, ndDocId); break; } catch { if (i < 4) await new Promise<void>((r) => setTimeout(r, i === 0 ? 2000 : 3000)); }
            }
          }

          if (msg.npDocxBase64 && msg.npFilename && msg.npPenandatangan) {
            await handleNPUpload(ndId, perihal, msg.npDocxBase64, msg.npFilename, msg.npPenandatangan, msg.templateId, ndEditPayload);
          }

          await simanStore.updateSimanTemplate(msg.templateId, { savedVariables: msg.variables, savedKdSatker: msg.variables.kd_satker ?? "" });
          send({ step: "done", status: "done", ndId });
        } catch (e) {
          send({ step: "error", status: "error", message: nadineErrMsg(e) });
        }
      }
    });
    return;
  }

  if (port.name !== "llm-stream") return;

  let abortController: AbortController | null = null;

  port.onDisconnect.addListener(() => {
    abortController?.abort();
  });

  port.onMessage.addListener(async (msg: LlmPortRequest) => {
    if (msg.type === "llm/chat") {
      await handleChat(port, msg);
      return;
    }
    if (msg.type !== "llm/summarize") return;

    const { ndId, skipCache } = msg;
    abortController = new AbortController();

    const send = (m: LlmStreamMsg) => {
      try {
        port.postMessage(m);
      } catch {
        /* port closed */
      }
    };

    // 1. Check cache first
    if (!skipCache) {
      const cached = await cache.getCached(ndId);
      if (cached) {
        send({ type: "llm/cached", text: cached });
        send({ type: "llm/done" });
        return;
      }
    }

    // 2. Fetch naskah detail + extract PDF body
    let naskahBody = "";
    let meta: { noNd?: string; perihal?: string; pengirim?: string; tanggal?: string } = {};

    try {
      send({ type: "llm/status", status: "Mengambil detail naskah…" });
      const detail = await nadine.getNaskahDetail(ndId);
      const data = detail.Data as Record<string, unknown> | undefined;
      console.log("[asguard] detail response keys:", data ? Object.keys(data) : "no data");

      if (data) {
        // Extract metadata from the nested DataNd structure
        const konsep = data.KonsepNaskah as Record<string, unknown> | undefined;
        const dataNd = (konsep?.DataNd ?? data.DataNd ?? data) as Record<string, unknown>;
        const pengirimNd = dataNd.PengirimND as Record<string, unknown> | undefined;
        const penandatangan = pengirimNd?.Penandatangan as Record<string, unknown> | undefined;

        meta = {
          noNd: (dataNd.NoNd as string) ?? undefined,
          perihal: (dataNd.Perihal as string) ?? undefined,
          pengirim:
            (penandatangan?.NamaPejabat as string) ??
            (dataNd.Pengirim as string) ??
            undefined,
          tanggal: (dataNd.TglNd as string) ?? (dataNd.TanggalKirim as string) ?? undefined,
        };

        /**
         * Ask the sidepanel to extract text from a PDF.
         * Service workers can't run pdf.js (import() is blocked on ServiceWorkerGlobalScope).
         * We send base64-encoded PDF bytes to the sidepanel (normal page) and wait for text back.
         */
        function askSidepanelExtract(base64: string): Promise<string> {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("pdf extract timeout")), 30_000);
            const handler = (m: LlmPortRequest) => {
              if (m.type === "pdf/text") {
                clearTimeout(timer);
                port.onMessage.removeListener(handler);
                resolve(m.text);
              }
            };
            port.onMessage.addListener(handler);
            send({ type: "pdf/extract", base64, maxPages: llmSettings.maxPages ?? 7 });
          });
        }

        /** Download a file then delegate text extraction to the sidepanel. */
        async function downloadAndExtract(pathOrUrl: string): Promise<string> {
          const bytes = await nadine.downloadFile(pathOrUrl);
          console.log(`[asguard] downloaded ${bytes.byteLength} bytes, sending to sidepanel for extraction`);
          const uint8 = new Uint8Array(bytes);
          const CHUNK = 8192;
          const chunks: string[] = [];
          for (let i = 0; i < uint8.length; i += CHUNK) {
            chunks.push(String.fromCharCode(...uint8.subarray(i, i + CHUNK)));
          }
          const base64 = btoa(chunks.join(""));
          return askSidepanelExtract(base64);
        }

        // --- Strategy 0: Try captured PDF from page interception (MOST RELIABLE) ---
        const captured = capturedPdfs.get(ndId) ?? capturedPdfs.get("__latest__");
        if (captured && Date.now() - captured.capturedAt < 5 * 60 * 1000) {
          console.log(`[asguard] using captured PDF from page: ${captured.url.slice(-60)}`);
          send({ type: "llm/status", status: "Menggunakan PDF dari halaman…" });
          try {
            const extractedText = await askSidepanelExtract(captured.base64);
            console.log(`[asguard] extracted ${extractedText.length} chars from captured PDF`);
            if (extractedText.trim().length > 50) {
              naskahBody = extractedText;
              send({ type: "llm/status", status: `Berhasil mengekstrak ${extractedText.length} karakter dari dokumen` });
            }
          } catch (capturedErr) {
            console.warn("[asguard] captured PDF extraction failed:", capturedErr);
          }
        }

        // --- Strategy 1: Try PathKonsep download if no captured PDF ---
        if (!naskahBody.trim()) {
          const pathKonsep =
            (dataNd.PathKonsep as string) ??
            (data.PathKonsep as string) ??
            (konsep?.PathKonsep as string) ??
            null;

          if (pathKonsep) {
            console.log("[asguard] trying PathKonsep download:", pathKonsep);
            send({ type: "llm/status", status: "Mengunduh dokumen PDF…" });
            try {
              const extractedText = await downloadAndExtract(pathKonsep);
              console.log(`[asguard] extracted ${extractedText.length} chars from PathKonsep`);
              if (extractedText.trim().length > 50) {
                naskahBody = extractedText;
                send({ type: "llm/status", status: `Berhasil mengekstrak ${extractedText.length} karakter` });
              }
            } catch (pdfErr) {
              console.warn("[asguard] PathKonsep download/extract failed:", pdfErr);
            }
          }
        }

        // --- Strategy 2: Try lampiran downloads ---
        if (!naskahBody.trim()) {
          send({ type: "llm/status", status: "Memeriksa lampiran…" });
          try {
            const lampiran = await nadine.getAttachments(ndId);
            const lampList = lampiran.Data?.Lampiran ?? [];
            console.log(`[asguard] found ${lampList.length} lampiran`);

            for (const lamp of lampList.slice(0, 5)) {
              const dlPath = lamp.DownloadPath;
              if (!dlPath) continue;
              console.log(`[asguard] trying lampiran: ${lamp.NamaFile} → ${dlPath}`);
              try {
                const lampText = await downloadAndExtract(dlPath);
                if (lampText.trim().length > 50) {
                  naskahBody += (naskahBody ? "\n\n" : "") + lampText;
                  send({ type: "llm/status", status: `Lampiran: ${lamp.NamaFile} (${lampText.length} kar)` });
                }
              } catch (lampErr) {
                console.warn(`[asguard] lampiran failed:`, lampErr);
              }
            }
          } catch {
            console.warn("[asguard] lampiran fetch failed");
          }
        }

        // --- Fallback: use perihal if we still have nothing ---
        if (!naskahBody.trim()) {
          console.warn("[asguard] no PDF text extracted, falling back to metadata");
          naskahBody = (dataNd.Perihal as string) ?? JSON.stringify(data).slice(0, 4000);
          send({ type: "llm/status", status: "⚠️ Tidak ada teks PDF — menggunakan metadata saja" });
        }
      } else {
        naskahBody = "Tidak ada data naskah.";
      }
    } catch (e) {
      const errMsg =
        e instanceof NadineNoTokenError
          ? "Sesi Nadine kadaluarsa — buka ulang Nadine lalu refresh."
          : e instanceof NadineHttpError
            ? `Gagal mengambil naskah: ${e.message}`
            : `Error: ${e instanceof Error ? e.message : String(e)}`;
      send({ type: "llm/error", error: errMsg });
      return;
    }

    // Send metadata to panel for display
    send({ type: "llm/meta", ...meta });

    // 3. Stream from llama.cpp
    // Truncate input: take first 80% + last 20% of the limit to preserve body & closing section
    const charLimit = llmSettings.maxInputChars ?? 4000;
    const body = charLimit > 0 && naskahBody.length > charLimit
      ? naskahBody.slice(0, Math.round(charLimit * 0.8)) +
        "\n…\n" +
        naskahBody.slice(-Math.round(charLimit * 0.2))
      : naskahBody;

    const messages = buildSummaryMessages(
      body,
      meta,
      llmSettings.systemPrompt || undefined,
    );

    let fullText = "";
    try {
      for await (const chunk of llama.streamChat(llmSettings, messages, abortController.signal)) {
        fullText += chunk;
        send({ type: "llm/chunk", text: chunk });
      }
      // Cache completed summary
      if (fullText.trim()) {
        await cache.setCached(ndId, fullText);
      }
      // Store extracted text for chat follow-ups
      naskahTextCache.set(ndId, { body: naskahBody, meta });
      send({ type: "llm/done" });
    } catch (e) {
      if (abortController.signal.aborted) return; // user navigated away
      const errMsg =
        e instanceof Error && e.message.includes("llama.cpp")
          ? e.message
          : `llama.cpp tidak terdeteksi di ${llmSettings.llamaUrl} — pastikan servernya berjalan.`;
      send({ type: "llm/error", error: errMsg });
    }
  });
});

// --- Chat handler ---

const CHAT_SYSTEM_PROMPT = `Kamu adalah asisten yang membantu menganalisis naskah dinas (surat resmi pemerintah Indonesia).
Berikut adalah isi naskah yang sedang dibahas:

---
{NASKAH_CONTENT}
---

Jawab pertanyaan user berdasarkan isi naskah di atas. Gunakan bahasa Indonesia formal. Jika pertanyaan tidak terkait naskah, jawab sesuai kemampuanmu.`;

async function handleChat(
  port: chrome.runtime.Port,
  msg: { ndId: string; history: ChatMessage[]; userMessage: string },
) {
  const abortController = new AbortController();
  port.onDisconnect.addListener(() => abortController.abort());

  const send = (m: LlmStreamMsg) => {
    try {
      port.postMessage(m);
    } catch {
      /* port closed */
    }
  };

  // Get naskah context — try cache first, then re-fetch
  let naskahText = "";
  const cached = naskahTextCache.get(msg.ndId);
  if (cached) {
    naskahText = cached.body;
  } else {
    // Re-fetch naskah metadata as fallback (chat should run after summary which populates the cache)
    try {
      const detail = await nadine.getNaskahDetail(msg.ndId);
      const data = detail.Data as Record<string, unknown> | undefined;
      if (data) {
        const konsep = data.KonsepNaskah as Record<string, unknown> | undefined;
        const dataNd = (konsep?.DataNd ?? data.DataNd ?? data) as Record<string, unknown>;
        naskahText = (dataNd.Perihal as string) ?? "";
      }
    } catch {
      // proceed with empty context
    }
  }

  // Build messages for llama.cpp
  const systemContent = CHAT_SYSTEM_PROMPT.replace("{NASKAH_CONTENT}", naskahText || "(naskah tidak tersedia)");
  const llmMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemContent },
  ];

  // Add conversation history
  for (const h of msg.history) {
    llmMessages.push({ role: h.role, content: h.content });
  }
  llmMessages.push({ role: "user", content: msg.userMessage });

  // Stream response
  let fullText = "";
  try {
    for await (const chunk of llama.streamChat(llmSettings, llmMessages, abortController.signal)) {
      fullText += chunk;
      send({ type: "llm/chunk", text: chunk });
    }
    send({ type: "llm/done" });
  } catch (e) {
    if (abortController.signal.aborted) return;
    const errMsg =
      e instanceof Error && e.message.includes("llama.cpp")
        ? e.message
        : `llama.cpp tidak terdeteksi di ${llmSettings.llamaUrl} — pastikan servernya berjalan.`;
    send({ type: "llm/error", error: errMsg });
  }
}

// --- Port-based template run ---

async function handleTemplateRun(
  port: chrome.runtime.Port,
  msg: TemplateRunRequest,
) {
  const send = (m: TemplateRunMsg) => {
    try { port.postMessage(m); } catch { /* port closed */ }
  };

  try {
    // 1. Load template
    const template = await templateStore.getById(msg.templateId);
    if (!template) {
      send({ type: "run/error", error: "Template tidak ditemukan" });
      return;
    }

    const payload = { ...template.payload };
    if (msg.perihalOverride) payload.Perihal = msg.perihalOverride;

    // 2. Create naskah
    send({ type: "run/step", step: 1, total: 6, label: "Membuat naskah dinas…" });
    const result = await nadine.createNaskah(payload);

    if (!result.Success) {
      send({ type: "run/error", error: result.Error || result.Message || "Gagal membuat naskah" });
      return;
    }

    const ndId = result.Data?.KonsepNaskah?.DataNd?.NdId;
    const docId = result.Data?.KonsepNaskah?.Id;
    if (!ndId) {
      send({ type: "run/error", error: "NdId tidak ditemukan dalam response" });
      return;
    }

    console.log(`[asguard] naskah created: ndId=${ndId}, docId=${docId}`);
    send({ type: "run/step", step: 2, total: 6, label: "Mempersiapkan dokumen…" });

    // 3. Generate edit link (retry up to 5x with delay)
    if (docId) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await sleep(attempt === 0 ? 1000 : 3000);
        try {
          const detail = await nadine.getNaskahDetailForEdit(ndId);
          const editPayload = (detail.Data as Record<string, unknown>) ?? {};
          await nadine.generateEditLink(ndId, docId, editPayload);
          console.log("[asguard] edit link generated");
          break;
        } catch (e) {
          if (attempt >= 4) console.warn("[asguard] edit link failed after 5 retries:", e);
        }
      }
    }

    // 4. Upload konsep ND if available
    if (template.konsepFile) {
      send({ type: "run/step", step: 3, total: 6, label: `Mengupload ${template.konsepFile.name}…` });
      const binary = atob(template.konsepFile.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      for (let retry = 0; retry < 10; retry++) {
        await sleep(retry === 0 ? 1000 : 2000);
        try {
          const uploadResult = await nadine.uploadKonsepFile(ndId, template.konsepFile.name, bytes);
          if ((uploadResult as { Success?: boolean }).Success) {
            console.log("[asguard] konsep ND uploaded");
            break;
          }
        } catch (e) {
          if (retry >= 9) console.warn("[asguard] konsep upload failed after 10 retries:", e);
        }
      }
    } else {
      send({ type: "run/step", step: 3, total: 6, label: "Skip upload (tidak ada file)" });
    }

    // 5. Nota Pengantar — create if eselon <= 3
    const pengirimParam = payload.PengirimNdParam as Record<string, unknown> | undefined;
    const pengirimData = (pengirimParam?.Pengirim ?? {}) as Record<string, unknown>;
    const eselon = pengirimData.Eselon as number | undefined;

    let npId: string | null = null;

    if (eselon !== undefined && eselon <= 3) {
      send({ type: "run/step", step: 4, total: 6, label: "Membuat Nota Pengantar…" });

      try {
        // Priority order for penandatangan:
        // 1. msg.penandatanganUnit — chosen by user in the RunModal picker (this run)
        // 2. template.notaPengantarData.Penandatangan — saved from a previous run
        // If neither exists, skip NP (should not happen since RunModal forces selection)
        let penandatanganUnit: Record<string, unknown> | null = null;

        if (msg.penandatanganUnit) {
          penandatanganUnit = msg.penandatanganUnit;
          // Auto-save this choice to the template so future runs don't prompt again
          await templateStore.update(template.id, {
            notaPengantarData: {
              Penandatangan: [penandatanganUnit],
              Pengirim: penandatanganUnit,
            },
          });
          console.log(`[asguard] NP: user-selected penandatangan saved to template: ${penandatanganUnit.NamaJabatan}`);
        } else if (template.notaPengantarData?.Penandatangan) {
          const saved = template.notaPengantarData.Penandatangan as Record<string, unknown>[];
          if (saved.length > 0) {
            penandatanganUnit = saved[0];
            console.log(`[asguard] NP: using saved penandatangan: ${penandatanganUnit.NamaJabatan}`);
          }
        }

        if (!penandatanganUnit) {
          console.warn("[asguard] NP: no penandatangan available — skipping NP creation");
          send({ type: "run/step", step: 4, total: 6, label: "Skip NP (pilih penandatangan terlebih dahulu)" });
        } else {
          const pengirimNP = (template.notaPengantarData?.Pengirim as Record<string, unknown> | undefined) ?? penandatanganUnit;

          const npPayload = {
            Perihal: payload.Perihal ?? "",
            Penandatangan: [penandatanganUnit],
            Pengirim: pengirimNP,
            Tujuan: pengirimData,
          };

          console.log("[asguard] NP payload:", JSON.stringify(npPayload).slice(0, 300));
          const createResp = await nadine.createNotaPengantar(ndId, npPayload);
          console.log("[asguard] NP create response:", JSON.stringify(createResp).slice(0, 200));

          // Poll for NP to be ready (up to 5 retries)
          for (let attempt = 0; attempt < 5; attempt++) {
            await sleep(1000);
            try {
              const npResponse = await nadine.getNotaPengantar(ndId);
              const npRaw = (npResponse as { Data?: unknown }).Data;
              const npData = Array.isArray(npRaw)
                ? (npRaw[0] as Record<string, unknown> | undefined)
                : (npRaw as Record<string, unknown> | undefined);
              npId = (npData?.Id as string | undefined) ?? null;
              if (npId) {
                console.log(`[asguard] NP created: id=${npId}`);
                break;
              }
            } catch { /* retry */ }
          }

          if (!npId) {
            console.warn("[asguard] NP: could not get ID after 5 retries");
          }

          // Upload NP konsep file if available
          if (npId && template.konsepNotaFile) {
            send({ type: "run/step", step: 5, total: 6, label: `Mengupload NP: ${template.konsepNotaFile.name}…` });
            const npBinary = atob(template.konsepNotaFile.base64);
            const npBytes = new Uint8Array(npBinary.length);
            for (let i = 0; i < npBinary.length; i++) npBytes[i] = npBinary.charCodeAt(i);

            for (let retry = 0; retry < 10; retry++) {
              await sleep(retry === 0 ? 1000 : 2000);
              try {
                const npUpload = await nadine.uploadNotaPengantarFile(ndId, npId, template.konsepNotaFile.name, npBytes);
                if ((npUpload as { Success?: boolean }).Success) {
                  console.log("[asguard] NP file uploaded");
                  break;
                }
              } catch { /* retry */ }
            }
          } else if (npId) {
            send({ type: "run/step", step: 5, total: 6, label: "NP dibuat (tidak ada file NP)" });
          }
        }
      } catch (e) {
        console.warn("[asguard] NP creation failed:", e);
        send({ type: "run/step", step: 4, total: 6, label: "NP gagal dibuat (dilanjutkan)" });
      }
    } else {
      const reason = eselon === undefined ? "eselon tidak tersedia" : `eselon ${eselon} > 3`;
      send({ type: "run/step", step: 4, total: 6, label: `Skip NP (${reason})` });
    }


    // 6. Sync ND document — use GET /gateway/stream/ndid/{ndId}/SyncDocKonsep/{docId}
    // The Python CLI only syncs after upload; we sync always to ensure the doc is ready
    if (docId) {
      send({ type: "run/step", step: 6, total: 6, label: "Sync dokumen…" });
      await sleep(2000); // Wait a bit for the server to process the upload

      for (let retry = 0; retry < 5; retry++) {
        try {
          await nadine.syncDocKonsep(ndId, docId);
          console.log("[asguard] sync OK");
          break;
        } catch (e) {
          console.warn(`[asguard] sync attempt ${retry + 1} failed:`, e);
          if (retry < 4) await sleep(retry === 0 ? 2000 : 3000);
        }
      }
    }

    send({ type: "run/done", ndId });
  } catch (e) {
    const errMsg = e instanceof NadineNoTokenError
      ? "Sesi Nadine kadaluarsa — buka ulang Nadine lalu refresh."
      : e instanceof NadineHttpError
        ? `Gagal: ${e.message}`
        : `Error: ${e instanceof Error ? e.message : String(e)}`;
    send({ type: "run/error", error: errMsg });
  }
}

// --- Mail merge batch runner ---

async function handleMailMergeRun(port: chrome.runtime.Port) {
  const sendProgress = (m: MailMergeProgressMsg) => {
    try { port.postMessage(m); } catch { /* port closed */ }
  };

  let templateId: string | null = null;
  let template: Awaited<ReturnType<typeof templateStore.getById>> = null;
  let mmPenandatanganUnit: Record<string, unknown> | null = null;
  let aborted = false;
  let success = 0;
  let failed = 0;
  let totalExpected = 0;
  let rowsProcessed = 0;
  const ndIds: number[] = [];

  port.onDisconnect.addListener(() => { aborted = true; });

  // Row-level handler — one row at a time (panel waits for row-done before sending next)
  const processRow = async (msg: Extract<MailMergeRowMsg, { type: "mm/row" }>) => {
    if (aborted) return;

    const step = (s: string) => sendProgress({ type: "mm/row-step", index: msg.index, step: s });

    try {
      const payload = { ...msg.payload };

      // 1. Create naskah
      step("Membuat naskah dinas…");
      const result = await nadine.createNaskah(payload);
      if (!result.Success) {
        throw new Error(result.Error || result.Message || "Gagal membuat naskah");
      }
      const ndId = result.Data?.KonsepNaskah?.DataNd?.NdId as number | undefined;
      const docId = result.Data?.KonsepNaskah?.Id as string | undefined;
      if (!ndId) throw new Error("NdId tidak ditemukan dalam response");

      step(`Naskah dibuat (ND #${ndId})`);

      // 2. Generate edit link (best-effort)
      if (docId) {
        await sleep(1000);
        step("Menyiapkan dokumen…");
        try {
          const detail = await nadine.getNaskahDetailForEdit(ndId);
          await nadine.generateEditLink(ndId, docId, (detail.Data as Record<string, unknown>) ?? {});
        } catch { /* non-fatal */ }
      }

      // 3. Upload rendered ND docx
      step(`Mengupload konsep ND: ${msg.filename}…`);
      const binary = atob(msg.docxBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      let ndUploaded = false;
      for (let retry = 0; retry < 3; retry++) {
        await sleep(retry === 0 ? 1000 : 2000);
        try {
          const up = await nadine.uploadKonsepFile(ndId, msg.filename, bytes);
          if ((up as { Success?: boolean }).Success) { ndUploaded = true; break; }
        } catch { if (retry >= 2) console.warn("[asguard] mm ND upload failed"); }
      }
      if (ndUploaded) step("Konsep ND berhasil diupload");
      else step("⚠️ Upload konsep ND gagal (dilanjutkan)");

      // 4. NP — use penandatangan chosen this run or saved from previous run
      if (template) {
        const pengirimParam = payload.PengirimNdParam as Record<string, unknown> | undefined;
        const pengirimData = (pengirimParam?.Pengirim ?? {}) as Record<string, unknown>;
        const eselon = pengirimData.Eselon as number | undefined;
        const savedPenandatangan = template.notaPengantarData?.Penandatangan as Record<string, unknown>[] | undefined;
        const penandatanganUnit = mmPenandatanganUnit ?? (savedPenandatangan?.[0] ?? null);
        if (eselon !== undefined && eselon <= 3 && penandatanganUnit) {
          step("Membuat Nota Pengantar…");
          try {
            const pengirimNP = (template.notaPengantarData?.Pengirim as Record<string, unknown> | undefined) ?? penandatanganUnit;
            const npPayload = {
              Perihal: payload.Perihal ?? "",
              Penandatangan: [penandatanganUnit],
              Pengirim: pengirimNP,
              Tujuan: pengirimData,
            };
            await nadine.createNotaPengantar(ndId, npPayload);

            // Poll for NP id
            let npId: string | null = null;
            for (let a = 0; a < 2; a++) {
              await sleep(1000);
              try {
                const npResp = await nadine.getNotaPengantar(ndId);
                const npRaw = (npResp as { Data?: unknown }).Data;
                const npData = Array.isArray(npRaw) ? (npRaw[0] as Record<string, unknown>) : (npRaw as Record<string, unknown>);
                npId = (npData?.Id as string | undefined) ?? null;
                if (npId) break;
              } catch { /* retry */ }
            }

            if (npId) {
              step(`Nota Pengantar dibuat (ID: ${npId})`);
              // Upload NP docx — prefer per-row rendered version, fall back to static template file
              const npBase64 = msg.npDocxBase64 ?? template.konsepNotaFile?.base64;
              const npName = msg.npFilename ?? template.konsepNotaFile?.name;
              if (npBase64 && npName) {
                step(`Mengupload konsep NP: ${npName}…`);
                const npBin = atob(npBase64);
                const npBytes = new Uint8Array(npBin.length);
                for (let i = 0; i < npBin.length; i++) npBytes[i] = npBin.charCodeAt(i);
                let npUploaded = false;
                for (let retry = 0; retry < 2; retry++) {
                  await sleep(retry === 0 ? 1000 : 2000);
                  try {
                    await nadine.uploadNotaPengantarFile(ndId, npId, npName, npBytes);
                    npUploaded = true;
                    break;
                  } catch { /* retry */ }
                }
                if (npUploaded) step("Konsep NP berhasil diupload");
                else step("⚠️ Upload konsep NP gagal (dilanjutkan)");
              }
            } else {
              step("⚠️ ID Nota Pengantar tidak ditemukan");
            }
          } catch (npErr) {
            console.warn("[asguard] mm NP failed:", npErr);
            step(`⚠️ Nota Pengantar gagal: ${npErr instanceof Error ? npErr.message : String(npErr)}`);
          }
        }
      }

      // 5. Sync
      if (docId) {
        step("Sinkronisasi dokumen…");
        await sleep(1500);
        let synced = false;
        for (let retry = 0; retry < 2; retry++) {
          try { await nadine.syncDocKonsep(ndId, docId); synced = true; break; }
          catch { if (retry < 1) await sleep(2000); }
        }
        if (synced) step("Dokumen berhasil disinkronisasi");
        else step("⚠️ Sinkronisasi gagal (dilanjutkan)");
      }

      success++;
      ndIds.push(ndId);
      sendProgress({ type: "mm/row-done", index: msg.index, ndId });
    } catch (e) {
      failed++;
      const errMsg = e instanceof NadineNoTokenError
        ? "Sesi kadaluarsa"
        : e instanceof NadineHttpError
          ? `HTTP ${e.status}: ${e.message}`
          : e instanceof Error ? e.message : String(e);
      sendProgress({ type: "mm/row-done", index: msg.index, error: errMsg });
    }

    rowsProcessed++;
    await sleep(500); // throttle between rows

    // Auto-complete when all rows are processed
    if (rowsProcessed >= totalExpected || aborted) {
      sendProgress({ type: "mm/complete", success, failed, ndIds });
    }
  };

  port.onMessage.addListener(async (msg: MailMergeRowMsg) => {
    if (msg.type === "mm/start") {
      templateId = msg.templateId;
      totalExpected = msg.total;
      template = await templateStore.getById(templateId);
      mmPenandatanganUnit = msg.penandatanganUnit ?? null;
      // Auto-save chosen penandatangan to template so future runs skip the picker
      if (mmPenandatanganUnit && template) {
        await templateStore.update(template.id, {
          notaPengantarData: {
            Penandatangan: [mmPenandatanganUnit],
            Pengirim: mmPenandatanganUnit,
          },
        });
        template = await templateStore.getById(templateId);
        console.log(`[asguard] mm: saved penandatangan to template: ${mmPenandatanganUnit.NamaJabatan}`);
      }
      return;
    }
    if (msg.type === "mm/abort") {
      aborted = true;
      sendProgress({ type: "mm/complete", success, failed, ndIds });
      return;
    }
    if (msg.type === "mm/row") {
      await processRow(msg);
    }
  });
}

// --- Arsiparis auto-archive runner ---

async function handleArsipRun(port: chrome.runtime.Port) {
  const send = (m: ArsipProgressMsg) => { try { port.postMessage(m); } catch { /* port closed */ } };
  let aborted = false;
  let confirmResolve: (() => void) | null = null;
  let pdfResolve: ((text: string) => void) | null = null;

  port.onDisconnect.addListener(() => {
    aborted = true;
    confirmResolve?.();
    pdfResolve?.("");
  });

  port.onMessage.addListener(async (msg: ArsipPortMsg) => {
    if (msg.type === "arsip/abort") {
      aborted = true;
      confirmResolve?.();
      pdfResolve?.("");
      return;
    }
    if (msg.type === "arsip/confirm") {
      confirmResolve?.();
      return;
    }
    if (msg.type === "arsip/pdf-text") {
      pdfResolve?.(msg.text);
      pdfResolve = null;
      return;
    }
    if (msg.type === "arsip/start-auto") {
      const waitForConfirm = () => new Promise<void>(r => { confirmResolve = r; });
      const askPanel = (base64: string, ndId: number): Promise<string> =>
        new Promise<string>(resolve => {
          pdfResolve = resolve;
          send({ type: "arsip/pdf-extract", base64, maxPages: 3, ndId });
          setTimeout(() => { if (pdfResolve) { pdfResolve = null; resolve(""); } }, 20_000);
        });
      await runAutoArsip(msg.docType, msg.startDate, msg.endDate, send, waitForConfirm, () => aborted, !!msg.useAI, askPanel);
    }
  });
}

async function runAutoArsip(
  docType: ArsipDocType,
  startDate: string,
  endDate: string,
  send: (m: ArsipProgressMsg) => void,
  waitForConfirm: () => Promise<void>,
  isAborted: () => boolean,
  useAI: boolean,
  askPanel: (base64: string, ndId: number) => Promise<string>,
) {
  // 1. Fetch unarchived items
  send({ type: "arsip/status", message: "Mengambil data naskah..." });
  let rawItems: Record<string, unknown>[] = [];
  try {
    let res: { Data?: unknown[] };
    if (docType === "konsep") res = await nadine.getArsipUnitUnarchived({ limit: 1000, startDate, endDate });
    else if (docType === "amplop") res = await nadine.getArsipAmplopUnarchived({ limit: 1000, startDate, endDate });
    else res = await nadine.getArsipDisposisiUnarchived({ limit: 1000, startDate, endDate });
    rawItems = (res.Data ?? []) as Record<string, unknown>[];
  } catch (e) {
    send({ type: "arsip/error", error: e instanceof Error ? e.message : String(e) });
    return;
  }

  if (rawItems.length === 0) {
    send({ type: "arsip/complete", success: 0, skipped: 0, created: 0, failed: 0 });
    return;
  }

  send({ type: "arsip/status", message: `${rawItems.length} naskah ditemukan. Menganalisis klasifikasi...` });

  // Pre-load klasifikasi reference (always needed for berkas creation; also used for AI options)
  const klasRef = new Map<string, { Id: number; Nama: string }>();
  let klasOptions = "";
  if (useAI) {
    send({ type: "arsip/status", message: `${rawItems.length} naskah ditemukan. Memuat daftar klasifikasi untuk AI...` });
    try {
      // Build klasRef from full list (needed for berkas creation later)
      const kRes = await nadine.getRefKlasifikasiArsipAll();
      const flattenAll = (items: unknown[]) => {
        for (const raw of items) {
          const k = raw as Record<string, unknown>;
          const kode = k.KodeKlasifikasi as string | undefined;
          const id = k.Id as number | undefined;
          const nama = k.Nama as string | undefined;
          if (kode && id) klasRef.set(kode, { Id: id, Nama: nama ?? kode });
          const children = k.Children as unknown[] | undefined;
          if (children?.length) flattenAll(children);
        }
      };
      flattenAll((kRes.Data ?? []) as unknown[]);
    } catch { /* proceed */ }
    try {
      // Build LLM options from fav list only — much shorter, avoids 20k-token prompts
      const favRes = await nadine.getRefKlasifikasiArsipFav();
      const favLines: string[] = [];
      const flattenFav = (items: unknown[]) => {
        for (const raw of items) {
          const k = raw as Record<string, unknown>;
          const kode = k.KodeKlasifikasi as string | undefined;
          const nama = k.Nama as string | undefined;
          if (kode && nama) favLines.push(`${kode} - ${nama}`);
          const children = k.Children as unknown[] | undefined;
          if (children?.length) flattenFav(children);
        }
      };
      flattenFav((favRes.Data ?? []) as unknown[]);
      klasOptions = favLines.join("\n");
    } catch { /* proceed without LLM */ }
  }

  // 2. Fetch detail + classify for each item
  const tipeData = docType === "amplop" ? "AmplopNd" : docType === "disposisi" ? "AmplopDisposisi" : "KonsepNaskah";
  const classified: Array<{ item: Record<string, unknown>; kode: string }> = [];

  for (let i = 0; i < rawItems.length; i++) {
    if (isAborted()) break;
    const item = rawItems[i];
    const ndId = item.NdId as number | undefined;
    let kode = "";
    if (ndId) {
      try {
        const detail = await nadine.getNaskahDetail(ndId, tipeData);
        const data = detail.Data as Record<string, unknown> | undefined;
        const dataNd = ((data?.DataNd ?? data) as Record<string, unknown> | undefined) ?? {};
        const klas = (dataNd?.Klasifikasi as Record<string, unknown> | undefined) ?? {};
        const metaKode = (klas?.KodeKlasifikasi as string | undefined) ?? "";
        const perihal = (dataNd?.Perihal as string | undefined) ?? "";

        send({ type: "arsip/classify-progress", done: i + 1, total: rawItems.length });

        if (useAI && klasOptions) {
          send({ type: "arsip/status", message: `(${i + 1}/${rawItems.length}) ${perihal || `NdId ${ndId}`}` });
          let llmKode = "";
          try {
            // Download PDF (max 3 pages) then classify — fav list is short so total prompt stays small
            const pathKonsep =
              (dataNd.PathKonsep as string | undefined) ??
              (data?.PathKonsep as string | undefined) ?? "";
            let naskahText = perihal;
            if (pathKonsep) {
              try {
                const bytes = await nadine.downloadFile(pathKonsep);
                const uint8 = new Uint8Array(bytes);
                const CHUNK = 8192;
                const parts: string[] = [];
                for (let j = 0; j < uint8.length; j += CHUNK) {
                  parts.push(String.fromCharCode(...uint8.subarray(j, j + CHUNK)));
                }
                const extracted = await askPanel(btoa(parts.join("")), ndId);
                if (extracted) naskahText = extracted;
              } catch { /* PDF failed, fall back to perihal */ }
            }
            const msgs = buildKlasifikasiMessages(naskahText, perihal, klasOptions);
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 30_000);
            let raw = "";
            try {
              for await (const chunk of llama.streamChat(
                { ...llmSettings, maxTokens: 50, temperature: 0.0 },
                msgs,
                ctrl.signal,
              )) raw += chunk;
            } finally { clearTimeout(timer); }
            const match = raw.match(/\b([A-Z]{2}\.\d{2}(?:\.\d{2})*)\b/);
            if (match && klasRef.has(match[1])) llmKode = match[1];
          } catch { /* fall back to meta kode */ }
          kode = llmKode || metaKode;
        } else {
          kode = metaKode;
        }
      } catch { /* no kode */ }
    } else {
      send({ type: "arsip/classify-progress", done: i + 1, total: rawItems.length });
    }
    classified.push({ item, kode });
    await sleep(80);
  }

  if (isAborted()) return;

  // 3. Group by KodeKlasifikasi
  const groupMap = new Map<string, Record<string, unknown>[]>();
  let skippedCount = 0;
  for (const { item, kode } of classified) {
    if (!kode) { skippedCount++; continue; }
    const arr = groupMap.get(kode) ?? [];
    arr.push(item);
    groupMap.set(kode, arr);
  }

  // 4. Load berkas list — build (kode, year) → berkasId map
  let berkasList: ArsipBerkas[] = [];
  try {
    const bRes = await nadine.getListBerkas({ berkasAktif: 1 });
    berkasList = (bRes.Data ?? []) as ArsipBerkas[];
  } catch { /* proceed */ }

  // Year from startDate DD-MM-YYYY → last part
  const year = startDate.split("-").at(-1) ?? String(new Date().getFullYear());
  const berkasMap = new Map<string, number>();
  for (const b of berkasList) {
    const bKode = b.KlasifikasiArsip?.KodeKlasifikasi ?? "";
    const bYear = String(b.KurunWaktu ?? "");
    if (bKode && bYear === year) berkasMap.set(bKode, b.Id);
  }

  // 5. Build groups preview
  const groups: ArsipGroup[] = [];
  for (const [kode, items] of groupMap.entries()) {
    const berkasId = berkasMap.get(kode);
    groups.push({ kode, count: items.length, berkasId, berkasExists: !!berkasId });
  }
  send({ type: "arsip/groups", groups });

  // 6. Wait for user to confirm
  await waitForConfirm();
  if (isAborted()) return;

  // 7. If non-AI mode, load klasRef now (AI mode already loaded it upfront)
  if (!useAI && klasRef.size === 0) {
    try {
      const kRes = await nadine.getRefKlasifikasiArsipAll();
      const flattenKlasRef = (items: unknown[]) => {
        for (const raw of items) {
          const k = raw as Record<string, unknown>;
          const kode = k.KodeKlasifikasi as string | undefined;
          const id = k.Id as number | undefined;
          const nama = k.Nama as string | undefined;
          if (kode && id) klasRef.set(kode, { Id: id, Nama: nama ?? kode });
          const children = k.Children as unknown[] | undefined;
          if (children?.length) flattenKlasRef(children);
        }
      };
      flattenKlasRef((kRes.Data ?? []) as unknown[]);
    } catch { /* proceed */ }
  }

  // 8. Archive each group
  let success = 0;
  let failed = 0;
  let createdCount = 0;
  const groupArr = Array.from(groupMap.entries());

  for (let gi = 0; gi < groupArr.length; gi++) {
    if (isAborted()) break;
    const [kode, items] = groupArr[gi];
    send({ type: "arsip/group-step", index: gi, total: groupArr.length, kode, step: "Menyiapkan berkas..." });

    let berkasId = berkasMap.get(kode);
    if (!berkasId) {
      const ref = klasRef.get(kode);
      if (ref) {
        try {
          await nadine.createBerkas({ KlasifikasiArsipId: ref.Id, UraianBerkas: `Berkaitan dengan ${ref.Nama}.`, KurunWaktu: year });
          await sleep(500);
          const newBRes = await nadine.getListBerkas({ berkasAktif: 1 });
          for (const b of (newBRes.Data ?? []) as ArsipBerkas[]) {
            if (b.KlasifikasiArsip?.KodeKlasifikasi === kode && String(b.KurunWaktu) === year) {
              berkasId = b.Id;
              berkasMap.set(kode, berkasId);
              createdCount++;
              break;
            }
          }
        } catch { /* failed to create */ }
      }
    }

    if (!berkasId) {
      failed += items.length;
      send({ type: "arsip/group-step", index: gi, total: groupArr.length, kode, step: "Gagal — berkas tidak ditemukan" });
      continue;
    }

    send({ type: "arsip/group-step", index: gi, total: groupArr.length, kode, step: `Mengarsipkan ${items.length} naskah...` });
    try {
      const archItems = items.map(it => ({
        Id: String(it.Id ?? it.AmplopId ?? ""),
        NdId: it.NdId as number,
      }));
      await nadine.berkaskanMultiple(docType, berkasId, archItems);
      success += items.length;
      send({ type: "arsip/group-step", index: gi, total: groupArr.length, kode, step: `${items.length} berhasil diarsipkan` });
    } catch (e) {
      failed += items.length;
      send({ type: "arsip/group-step", index: gi, total: groupArr.length, kode, step: `Gagal: ${e instanceof Error ? e.message : String(e)}` });
    }
    await sleep(300);
  }

  send({ type: "arsip/complete", success, skipped: skippedCount, created: createdCount, failed });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {};
