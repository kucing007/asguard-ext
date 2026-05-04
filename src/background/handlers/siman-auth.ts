/** SIMAN token capture, role-data interception, and role context enrichment. */
import * as simanStore from "../siman-store";
import * as simanClient from "../siman-client";
import * as state from "../state";
import { debugLog, safeErrorMessage } from "@/shared/logging";
import type { SimanRole, SimanRoleContext } from "@/shared/siman-types";

export async function handleSimanToken(
  raw: { token: string; origin: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const payload = simanClient.decodeJwtPayload(raw.token);
  // Check top-level AND nested `.data` object (common in govt JWTs)
  const nested =
    typeof payload.data === "object" && payload.data !== null
      ? (payload.data as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  debugLog("[asguard] SIMAN JWT payload:", payload);
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
      const me = (await meRes.json()) as Record<string, unknown>;
      const d = (me.data ?? me) as Record<string, unknown>;
      debugLog("[asguard] SIMAN /me response keys:", Object.keys(d));
      userMeta = {
        idUser: String(d.id_user ?? d.id ?? ""),
        nip: String(d.nip ?? d.username ?? payload.nip ?? payload.username ?? ""),
        fullname: String(d.fullname ?? d.nama ?? d.name ?? ""),
        jabatan: String(d.jabatan ?? d.jabatan_pengguna ?? ""),
        idKpknl: String(d.id_kpknl ?? d.kd_kpknl ?? "0"),
        idKanwil: String(d.id_kanwil ?? d.kd_kanwil ?? "0"),
        idRole: String(d.id_role ?? ""),
        idStruktur: String(d.id_struktur ?? d.id_struktur_termohon ?? "9"),
      };
      debugLog("[asguard] SIMAN /me profile:", userMeta);
    }
  } catch (e) {
    console.warn("[asguard] SIMAN /me failed:", safeErrorMessage(e));
  }

  // Use /me id_user as primary; fall back to JWT-extracted id
  const userId = userMeta.idUser || userIdFromJwt;
  if (!userId) {
    console.warn("[asguard] SIMAN: no userId from JWT or /me — storing token without userId");
  }

  const changed = await simanStore.setSimanToken(raw.token, {
    userId,
    nip: userMeta.nip || String(payload.nip ?? payload.username ?? ""),
    fullname: userMeta.fullname || String(payload.fullname ?? payload.name ?? payload.nama ?? ""),
    jabatan: userMeta.jabatan || String(payload.jabatan ?? payload.jabatan_pengguna ?? ""),
  });

  // Fetch role context if: (a) no role yet, or (b) kpknl is still "0" (stale minimal context)
  const tokenType = String(payload.t ?? "");
  const currentState = simanStore.getSimanToken();
  const needsRoleFetch = tokenType === "R" && (!currentState.role || currentState.role.idKpknl === "0");
  if (needsRoleFetch) {
    const uidFromJwt = String(payload.uid ?? "");
    const meKpknl = userMeta.idKpknl ?? "0";
    const meKanwil = userMeta.idKanwil ?? "0";
    const meRole = userMeta.idRole ?? "";
    const meStruktur = userMeta.idStruktur ?? "9";

    if (meKpknl !== "0") {
      const roleContext: SimanRoleContext = {
        idUserDetail: uidFromJwt,
        idUser: userId,
        idRole: meRole || "1",
        nmRole: userMeta.jabatan || "Auto",
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
      debugLog("[asguard] SIMAN role from /me", { idKpknl: meKpknl });
    } else {
      try {
        const filterArr = uidFromJwt ? await simanClient.getRoleFilter(uidFromJwt) : [];
        const fd = (filterArr[0] ?? {}) as Record<string, unknown>;
        debugLog("[asguard] user-detail-filter result:", fd);
        const roleContext: SimanRoleContext = {
          idUserDetail: uidFromJwt || String(fd.id_user_detail ?? ""),
          idUser: userId,
          idRole: String(fd.id_role ?? "1"),
          nmRole: String(fd.nm_role ?? userMeta.jabatan ?? "Auto"),
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
        debugLog("[asguard] SIMAN role from user-detail-filter", { idKpknl: roleContext.idKpknl });
      } catch (e) {
        console.warn("[asguard] user-detail-filter failed:", safeErrorMessage(e));
        const roleContext: SimanRoleContext = {
          idUserDetail: uidFromJwt,
          idUser: userId,
          idRole: "1",
          nmRole: userMeta.jabatan || "Auto",
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

  if (changed) {
    debugLog("[asguard] SIMAN token captured", { host: new URL(raw.origin).hostname });
    state.setActiveTab("siman");
    state.broadcastState();
  }
  // Always attempt license check on every SIMAN token message (fire-and-forget)
  const simanNip = simanStore.getSimanToken().nip ?? "";
  const simanName = simanStore.getSimanToken().fullname ?? "";
  debugLog("[asguard] SIMAN license check candidate", { hasNip: /^\d{9,18}$/.test(simanNip) });
  if (/^\d{9,18}$/.test(simanNip)) {
    if (!state.licenseStatus || state.licenseStatus.status === "offline" || state.licenseStatus.status === "error") {
      state.refreshLicense(simanNip, simanName).then(() => state.broadcastState()).catch(() => {});
    }
  }
  sendResponse({ ok: true });
}

/** Auto-set role context from intercepted SIMAN web traffic. */
export async function handleSimanRoleData(
  raw: { roleData: Record<string, unknown> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const rd = raw.roleData;
  debugLog("[asguard] siman/role-data received:", rd);
  const currentState = simanStore.getSimanToken();
  if (!currentState.token) {
    sendResponse({ ok: false, error: "No SIMAN token yet" });
    return;
  }

  // Case 1: jwt-roles response (contains token + role data)
  if (rd.token && typeof rd.token === "string") {
    const rolePayload = simanClient.decodeJwtPayload(rd.token as string);
    const roleContext: SimanRoleContext = {
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
    debugLog("[asguard] auto-set SIMAN role from jwt-roles interception", { nmRole: roleContext.nmRole });
    state.broadcastState();
    sendResponse({ ok: true });
    return;
  }

  // Case 2: Array of roles — if only one, auto-pick it
  if (Array.isArray(rd.roles) && rd.roles.length > 0) {
    const roles = rd.roles as Record<string, unknown>[];
    const activeRole = roles[0];
    try {
      const role: SimanRole = {
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
      debugLog("[asguard] auto-set SIMAN role from intercepted roles list", { nmRole: role.nm_role });
      state.broadcastState();
    } catch (e) {
      console.warn("[asguard] auto-set role failed:", safeErrorMessage(e));
    }
    sendResponse({ ok: true });
    return;
  }

  // Case 3: Filter data (kpknl/kanwil) — enrich existing role or create minimal role
  if (rd.filterData && typeof rd.filterData === "object") {
    const fd = rd.filterData as Record<string, unknown>;
    if (!currentState.role && (fd.id_kpknl || fd.id_kanwil)) {
      const roleContext: SimanRoleContext = {
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
      debugLog("[asguard] auto-set SIMAN role from filter data");
      state.broadcastState();
    }
    sendResponse({ ok: true });
    return;
  }

  // Case 4: Direct role data from localStorage
  if (rd.id_kpknl || rd.id_kanwil || rd.id_role) {
    if (!currentState.role) {
      const roleContext: SimanRoleContext = {
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
      debugLog("[asguard] auto-set SIMAN role from localStorage data");
      state.broadcastState();
    }
    sendResponse({ ok: true });
    return;
  }

  sendResponse({ ok: true });
}

// --- Internal helpers ---

/** Enrich an auto-detected role context with display fields from the roles API. */
async function enrichRoleContextAsync(userId: string): Promise<void> {
  const current = simanStore.getSimanToken();
  if (!current.role || !current.token) return;
  if (current.role.namaRoleStruktur && current.role.namaUnit && current.role.idKpknl !== "0") return; // already enriched
  try {
    const roles = await simanClient.getRoles(userId);
    const match =
      roles.find((r) => r.id_role === current.role!.idRole) ??
      roles.find((r) => r.id_kpknl === current.role!.idKpknl) ??
      (roles.length === 1 ? roles[0] : undefined);
    if (!match) return;
    const enriched: SimanRoleContext = {
      ...current.role,
      idKpknl: current.role.idKpknl === "0" ? String(match.id_kpknl ?? "0") : current.role.idKpknl,
      idKanwil: current.role.idKanwil === "0" ? String(match.id_kanwil ?? "0") : current.role.idKanwil,
      namaRoleStruktur: current.role.namaRoleStruktur || String(match.nama_role_struktur ?? match.nm_role ?? ""),
      nmKpknl: current.role.nmKpknl || String(match.nm_kpknl ?? match.nama_unit ?? ""),
      namaUnit: current.role.namaUnit || String(match.nama_unit ?? ""),
      nmKanwil: current.role.nmKanwil || String(match.nm_kanwil ?? match.ur_kanwil ?? ""),
      urKanwil: current.role.urKanwil || String(match.ur_kanwil ?? ""),
    };
    await simanStore.setSimanRole(enriched, current.token);
    state.broadcastState();
    debugLog("[asguard] enriched role context:", {
      namaRoleStruktur: enriched.namaRoleStruktur,
      namaUnit: enriched.namaUnit,
    });
  } catch (e) {
    console.warn("[asguard] enrichRoleContextAsync failed:", safeErrorMessage(e));
  }
}
