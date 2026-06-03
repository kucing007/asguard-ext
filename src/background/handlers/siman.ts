/** SIMAN panel request handlers — roles, penetapan, templates, state management. */
import * as simanStore from "../siman-store";
import * as simanClient from "../siman-client";
import * as state from "../state";
import * as notifications from "./notifications";
import { debugLog, safeErrorMessage } from "@/shared/logging";
import type { SimanRole } from "@/shared/siman-types";

export async function handleSimanState(sendResponse: (r: unknown) => void): Promise<void> {
  sendResponse(state.snapshot());
}

export async function handleSimanTokenClear(sendResponse: (r: unknown) => void): Promise<void> {
  await simanStore.clearSimanToken();
  state.setCapturedPenetapanBody(null);
  state.broadcastState();
  sendResponse(state.snapshot());
}

export async function handleSimanPenetapanBody(
  raw: { body: Record<string, unknown> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  state.setCapturedPenetapanBody(raw.body as Record<string, unknown>);
  debugLog("[asguard] stored captured penetapan body", { hasBody: !!state.capturedPenetapanBody });
  sendResponse({ ok: true });
}

export async function handleSimanGetRoles(sendResponse: (r: unknown) => void): Promise<void> {
  const { userId } = simanStore.getSimanToken();
  if (!userId) {
    sendResponse({ ok: false, error: "No SIMAN token" });
    return;
  }
  try {
    const roles = await simanClient.getRoles(userId);
    sendResponse({ ok: true, data: roles });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanSetRole(
  raw: { role: SimanRole; idKpknl: string; idKanwil: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const { fullname, userId } = simanStore.getSimanToken();
  if (!userId) {
    sendResponse({ ok: false, error: "No SIMAN token" });
    return;
  }
  try {
    const idUserDetail = String(raw.role.id_user_detail ?? userId ?? "");
    const filterData = await simanClient.getRoleFilter(idUserDetail);
    const prevRole = simanStore.getSimanToken().role;
    const { token, context } = await simanClient.setRole(raw.role, filterData, fullname ?? "");
    await simanStore.setSimanRole(context, token);
    // Different role = different ticket scope. Re-prime SIMAN seen-set so the
    // next poll cycle doesn't flood-notify on tickets that were always visible
    // under the new role.
    if (!prevRole || prevRole.idRole !== context.idRole || prevRole.idStruktur !== context.idStruktur) {
      await notifications.onSimanRoleChanged();
    }
    state.broadcastState();
    sendResponse(state.snapshot());
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetTipePengelolaan(sendResponse: (r: unknown) => void): Promise<void> {
  try {
    const data = await simanClient.getTipePengelolaan();
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetPenetapanList(
  raw: { limit: number; offset: number; statusFilter?: string; idTipe?: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const { role } = simanStore.getSimanToken();
  if (!role) {
    sendResponse({ ok: false, error: "No SIMAN role selected" });
    return;
  }
  debugLog("[asguard] penetapan role context:", role);
  debugLog("[asguard] captured body available:", !!state.capturedPenetapanBody);
  try {
    const data = await simanClient.getPenetapanList(
      role,
      raw.limit,
      raw.offset,
      raw.statusFilter,
      raw.idTipe,
      state.capturedPenetapanBody ?? undefined,
    );
    sendResponse({ ok: true, data });
  } catch (e) {
    console.error("[asguard] penetapan error:", safeErrorMessage(e));
    sendResponse({ ok: false, error: safeErrorMessage(e) });
  }
}

export async function handleSimanGetPenetapanDetail(
  raw: { noTiket: string; idPengelolaan?: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const id = raw.idPengelolaan ?? raw.noTiket;
    const data = await simanClient.getPermohonanDetail(id);
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetKelengkapan(
  raw: { idPengelolaan: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const data = await simanClient.getKelengkapanDokumen(raw.idPengelolaan);
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetDownloadToken(
  raw: { idPengelolaanDok: number; nmFile: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const token = await simanClient.getDownloadToken(raw.idPengelolaanDok, raw.nmFile);
    const url = simanClient.getFileStreamUrl(token, raw.nmFile);
    sendResponse({ ok: true, token, url });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetDownloadTokenModel(
  raw: { id: number; filename: string; model: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const token = await simanClient.getDownloadTokenWithModel(raw.id, raw.filename, raw.model);
    const url = simanClient.getFileStreamUrl(token, raw.filename);
    sendResponse({ ok: true, token, url });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetTemplates(sendResponse: (r: unknown) => void): Promise<void> {
  sendResponse({ ok: true, data: await simanStore.getAllSimanTemplates() });
}

export async function handleSimanSaveTemplate(
  raw: { template: Record<string, unknown> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  sendResponse({ ok: true, data: await simanStore.saveSimanTemplate(raw.template as Parameters<typeof simanStore.saveSimanTemplate>[0]) });
}

export async function handleSimanTemplateUpdate(
  raw: { id: string; updates: Record<string, unknown> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  sendResponse({ ok: true, data: await simanStore.updateSimanTemplate(raw.id, raw.updates as Parameters<typeof simanStore.updateSimanTemplate>[1]) });
}

export async function handleSimanDeleteTemplate(
  raw: { id: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  sendResponse({ ok: true, data: await simanStore.deleteSimanTemplate(raw.id) });
}

export async function handleSimanGetKanwilList(sendResponse: (r: unknown) => void): Promise<void> {
  try {
    sendResponse({ ok: true, data: await simanClient.getKanwilList() });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetKpknlList(sendResponse: (r: unknown) => void): Promise<void> {
  try {
    sendResponse({ ok: true, data: await simanClient.getKpknlList() });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

// --- Evaluasi BMN handlers ---

export async function handleEvalPaketList(
  raw: { limit: number; offset: number; tahun?: number; statusPaket?: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const { role } = simanStore.getSimanToken();
  if (!role) {
    sendResponse({ ok: false, error: "No SIMAN role selected" });
    return;
  }
  debugLog("[asguard] eval/paket-list role available", { hasRole: true });
  try {
    const data = await simanClient.getPaketEvaluasi(role, raw.limit, raw.offset, {
      tahun: raw.tahun,
      status_paket: raw.statusPaket,
    });
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleEvalAsetList(
  raw: { noPaket: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    sendResponse({ ok: true, data: await simanClient.getAsetByPaket(raw.noPaket) });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleEvalLaksana(
  raw: { idSiapBmn: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    sendResponse({ ok: true, data: await simanClient.getLaksana(raw.idSiapBmn) });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleEvalRefSkor(
  raw: { kdSubSub: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    sendResponse({ ok: true, data: await simanClient.getRefSkor(raw.kdSubSub) });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleEvalEditEvaluasi(
  raw: { aset: Record<string, unknown>; caraEvaluasi: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const { role } = simanStore.getSimanToken();
  if (!role) { sendResponse({ ok: false, error: "No role" }); return; }
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const payload = {
    id_siap_bmn: raw.aset.id_siap_bmn,
    cara_evaluasi: raw.caraEvaluasi,
    created_by: Number(role.idUser) || 0,
    updated_by: Number(role.idUser) || 0,
    edited_by: Number(role.idUser) || 0,
    no_paket: raw.aset.no_paket,
    tahun: raw.aset.tahun ?? new Date().getFullYear(),
    status_proses: "Update Aset Evaluasi",
    status_ket: "Update Cara Evaluasi Aset",
    id_user: Number(role.idUser) || 0,
    nm_pengguna: simanStore.getSimanToken().fullname ?? "",
    tgl_create: now,
  };
  try {
    sendResponse({ ok: true, data: await simanClient.editEvaluasi(payload) });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleEvalEditSurvey(
  raw: { aset: Record<string, unknown>; tglSurvey: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const { role } = simanStore.getSimanToken();
  if (!role) { sendResponse({ ok: false, error: "No role" }); return; }
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const payload = {
    id_siap_bmn: raw.aset.id_siap_bmn,
    tgl_survey: raw.tglSurvey,
    created_by: Number(role.idUser) || 0,
    updated_by: Number(role.idUser) || 0,
    status_data: 1,
    edited_by: Number(role.idUser) || 0,
    no_paket: raw.aset.no_paket,
    tahun: raw.aset.tahun ?? new Date().getFullYear(),
    status_proses: "Update Aset Evaluasi",
    status_ket: "Update Tanggal Survey Evaluasi Aset",
    id_user: Number(role.idUser) || 0,
    nm_pengguna: simanStore.getSimanToken().fullname ?? "",
    tgl_create: now,
    stat_data: "Y",
  };
  try {
    sendResponse({ ok: true, data: await simanClient.editSurvey(payload) });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleEvalEditStatus(
  raw: { aset: Record<string, unknown> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const { role } = simanStore.getSimanToken();
  if (!role) { sendResponse({ ok: false, error: "No role" }); return; }
  try {
    const idSiapBmn = String(raw.aset.id_siap_bmn);
    const uid = Number(role.idUser) || 0;
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);

    // Step 5: Calculate 151216 (Aset Non Komersial)
    const laksanaAll = await simanClient.getLaksana(idSiapBmn);
    const laksanaMap: Record<string, Record<string, unknown>> = {};
    for (const l of laksanaAll) { const kd = String((l as Record<string, unknown>).kd_sub_sub ?? ""); if (kd) laksanaMap[kd] = l as Record<string, unknown>; }
    const l151216 = laksanaMap["151216"];
    if (l151216) {
      const v12 = Number(laksanaMap["151212"]?.nilai_sub_sub ?? 0);
      const v13 = Number(laksanaMap["151213"]?.nilai_sub_sub ?? 0);
      const v14 = Number(laksanaMap["151214"]?.nilai_sub_sub ?? 0);
      const v15 = Number(laksanaMap["151215"]?.nilai_sub_sub ?? 0);
      const isTanah = String(raw.aset.kd_brg ?? "").startsWith("2");
      const num = isTanah ? v13 + v14 : v12 + v13 + v14;
      let nilai = 0, skor = 0, scoreColor = "Abu-abu";
      if (v15 > 0 && num > 0) { nilai = num / v15; skor = nilai < 1 ? 8 : 3; scoreColor = nilai < 1 ? "Hijau" : "Merah"; }
      await simanClient.editLaksana({
        id_laksana: l151216.id_laksana, id_laks_ind: l151216.id_laks_ind, no_paket: l151216.no_paket,
        kd_sub_sub_indikator: "151216", ur_sub_sub: l151216.ur_sub_sub, ur_sub_indikator: l151216.ur_sub_sub, ur_indikator: l151216.ur_sub_sub,
        status_na_nu: "US", skor: String(skor), ket_na_nu: null, score_color: scoreColor, status_proses: "Y", nilai_sub_sub: nilai,
      });
    }

    // Step 6: Edit Subsub (stat_nil_subsub → Y for each id_laks_ind)
    const laksanaInd = await simanClient.getLaksanaIndikator(idSiapBmn);
    for (const ind of laksanaInd) {
      const lid = String((ind as Record<string, unknown>).id_laks_ind ?? "");
      if (lid) await simanClient.editSubsub(lid);
    }

    // Step 7: Hitung Score Card BMN (2x iteration)
    const seen = new Set<string>();
    const idLaksIndList: string[] = [];
    for (const l of laksanaAll) {
      const lid = String((l as Record<string, unknown>).id_laks_ind ?? "");
      if (lid && !seen.has(lid)) { seen.add(lid); idLaksIndList.push(lid); }
    }
    let results: { id: string; skor: number; warna: string }[] = [];
    for (let iter = 0; iter < 2; iter++) {
      results = [];
      for (const lid of idLaksIndList) {
        const countRes = await simanClient.getCountUs(lid) as Record<string, unknown>;
        const countData = ((countRes.data ?? []) as Record<string, unknown>[])[0] ?? {};
        const jml = Number(countData.jml_hitung ?? 0);
        let warna = jml >= 4 ? "green" : "red";
        if (jml > 0) {
          const konvRes = await simanClient.getKonversiSkor(jml) as Record<string, unknown>;
          const konvData = ((konvRes.data ?? []) as Record<string, unknown>[])[0] ?? {};
          const ket = String(konvData.ket ?? "").toLowerCase();
          if (ket === "hijau") warna = "green"; else if (ket === "merah") warna = "red";
        }
        await simanClient.editSkorAkhir(lid, jml, warna);
        results.push({ id: lid, skor: jml, warna });
      }
    }

    // Step 7b: Determine kinerja
    let hijau = 0, merah = 0, abu = 0;
    for (const r of results) { if (r.warna === "green") hijau++; else if (r.warna === "red") merah++; else abu++; }
    const kinerja = hijau === 6 ? "BAIK SEKALI" : abu > 2 ? "INVALID" : hijau > merah ? "BAIK" : "BURUK";

    // Step 8: Update Score Card Status Nilai
    await simanClient.updateStatusNilai({
      no_paket: raw.aset.no_paket, stat_nil_bmn: "Y",
      created_by: uid, updated_by: uid, edited_by: uid,
      tahun: raw.aset.tahun ?? new Date().getFullYear(),
      status_proses: "Score Card BMN", status_ket: "Melakukan Perhitungan Score Card BMN",
      id_user: uid, nm_pengguna: simanStore.getSimanToken().fullname ?? "", tgl_create: now,
    });

    // Step 9: Update Status → SELESAI
    await simanClient.editStatus(idSiapBmn, kinerja);
    sendResponse({ ok: true, data: { kinerja, scorecard: results } });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleEvalEditLaksana(
  raw: { payload: Record<string, unknown> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    sendResponse({ ok: true, data: await simanClient.editLaksana(raw.payload) });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleEvalGenerate15(
  raw: { aset: Record<string, unknown> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const { role } = simanStore.getSimanToken();
  if (!role) { sendResponse({ ok: false, error: "No role" }); return; }
  try {
    // Fetch interval + bobot refs
    const [intervalArr, bobotArr] = await Promise.all([
      simanClient.getInterval(),
      simanClient.getBobotAktif(),
    ]);
    const interval = intervalArr[0] ?? {};
    const bobot = bobotArr[0] ?? {};
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const a = raw.aset;
    const uid = Number(role.idUser) || 0;
    const payload = {
      created_by: uid,
      updated_by: uid,
      edited_by: uid,
      id_siap_bmn: a.id_siap_bmn,
      no_paket: a.no_paket,
      tahun: a.tahun ?? new Date().getFullYear(),
      id_aset: a.id_aset,
      id_satker: a.id_satker,
      id_kpknl: a.id_kpknl ?? (Number(role.idKpknl) || 0),
      ur_kpknl: a.ur_kpknl ?? "",
      id_kanwil: a.id_kanwil,
      kd_jns_bmn: a.kd_jns_bmn,
      kd_peruntukan: a.kd_peruntukan ?? "P1",
      ur_peruntukan: a.ur_peruntukan ?? "KANTOR",
      kd_satker: a.kd_satker ?? "",
      ur_satker: a.ur_satker ?? "",
      kd_brg: a.kd_brg ?? "",
      no_aset: a.no_aset,
      ur_sskel: a.ur_sskel ?? "",
      id_user: uid,
      tgl_create: now,
      status_proses: "N",
      stat_data: "Y",
      id_interval0: (interval as Record<string, unknown>).id_interval0 ?? 133,
      ur_sub: "Aset Non Komersial",
      id_pembobotan: Number((bobot as Record<string, unknown>).id_bobot ?? 128),
    };
    sendResponse({ ok: true, data: await simanClient.generate15(payload) });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

// --- Monitoring Pengelolaan handlers ---

export async function handleMonitoringList(
  raw: { filterId: number; idTipePengelolaan?: number; idStatus?: number; termohon?: number; limit: number; offset: number },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const data = await simanClient.getMonitoringList(
      raw.filterId, raw.idTipePengelolaan ?? 0, raw.idStatus ?? 9, raw.termohon ?? 0, raw.limit, raw.offset,
    );
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: safeErrorMessage(e) });
  }
}

export async function handleGetStatusTiket(sendResponse: (r: unknown) => void): Promise<void> {
  try {
    sendResponse({ ok: true, data: await simanClient.getStatusTiketList() });
  } catch (e) {
    sendResponse({ ok: false, error: safeErrorMessage(e) });
  }
}

export async function handleGetAllTipePengelolaan(sendResponse: (r: unknown) => void): Promise<void> {
  try {
    sendResponse({ ok: true, data: await simanClient.getAllTipePengelolaan() });
  } catch (e) {
    sendResponse({ ok: false, error: safeErrorMessage(e) });
  }
}

export async function handleGetStrukturTermohon(sendResponse: (r: unknown) => void): Promise<void> {
  try {
    sendResponse({ ok: true, data: await simanClient.getStrukturTermohon() });
  } catch (e) {
    sendResponse({ ok: false, error: safeErrorMessage(e) });
  }
}

export async function handleGetDokAnalisis(
  raw: { idPengelolaan: string; idStruktur?: number },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const data = await simanClient.getDokumenAnalisis(raw.idPengelolaan, raw.idStruktur ?? 9);
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: safeErrorMessage(e) });
  }
}

export async function handleGetSkByTiketMonitoring(
  raw: { idPengelolaan: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    sendResponse({ ok: true, data: await simanClient.getSkByTiket(raw.idPengelolaan) });
  } catch (e) {
    sendResponse({ ok: false, error: safeErrorMessage(e) });
  }
}

/**
 * Batch-check tindak lanjut status for tickets visible on the penetapan page.
 * Input: { noTikets: string[] }
 * Output: { ok: true, data: { [noTiket: string]: { status, tooltip } } }
 *   status: "Sudah Tinjut" | "Ada Bukti" | "Belum Tinjut"
 *   tooltip: last status_permohonan from log transaksi (for Belum Tinjut / Ada Bukti)
 */
export async function handleCheckTinjutBatch(
  raw: { noTikets: string[] },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const { role } = simanStore.getSimanToken();
    if (!role) {
      sendResponse({ ok: false, error: "No SIMAN role" });
      return;
    }

    // Fetch penetapan list to get noTiket -> idPengelolaan mapping
    const listRes = await simanClient.getPenetapanList(
      role, 500, 0, undefined, undefined, state.capturedPenetapanBody ?? undefined,
    );
    const tiketMap = new Map<string, string>();
    const tipeMap = new Map<string, string>(); // noTiket -> idTipePengelolaan
    for (const item of listRes.data) {
      const nt = item.noTiket ?? "";
      const idP = item.idPengelolaan ?? "";
      if (nt && idP) {
        tiketMap.set(nt, idP);
        tipeMap.set(nt, item.idTipePengelolaan ?? "");
      }
    }

    const result: Record<string, {
      status: string;
      lastStatus: string;
      lastDate: string;
      lastBy: string;
      lastRole: string;
      kodeStatus: string;
    }> = {};
    const requested = new Set(raw.noTikets);

    // Check each requested ticket — skip PSP (idTipePengelolaan=1, no tinjut)
    const checks = Array.from(requested).filter((nt) => {
      if (!tiketMap.has(nt)) return false;
      const tipe = tipeMap.get(nt) ?? "";
      if (tipe === "1") return false; // PSP — no tindak lanjut
      return true;
    }).map(async (nt) => {
      const idP = tiketMap.get(nt)!;
      const idTipe = Number(tipeMap.get(nt) ?? 0);
      const base = { lastStatus: "", lastDate: "", lastBy: "", lastRole: "", kodeStatus: "" };
      try {
        // 1. Check log transaksi for kode_status 2.9.5
        const logRes = await simanClient.getLogTransaksiTindakLanjut(idP, 10, 0);
        const lastLog = logRes.data.length > 0 ? logRes.data[0] : null;
        if (lastLog) {
          base.lastStatus = String(lastLog.status_permohonan ?? "");
          base.lastDate = String(lastLog.created_at ?? "");
          base.lastBy = String(lastLog.fullname ?? "");
          base.lastRole = String(lastLog.role ?? "");
          base.kodeStatus = String(lastLog.kode_status ?? "");
        }

        if (lastLog && String(lastLog.kode_status ?? "") === "2.9.5") {
          result[nt] = { status: "Sudah Tinjut", ...base };
          return;
        }

        // 2. Check rekam-tindak-lanjut for evidence (bukti)
        try {
          const rekamRes = await simanClient.getRekamTindakLanjut(idP, idTipe, 1, 0);
          if (rekamRes.total > 0 || rekamRes.data.length > 0) {
            result[nt] = { status: "Ada Bukti", ...base };
            return;
          }
        } catch {
          // Ignore rekam check failure, fall through to Belum Tinjut
        }

        // 3. Neither done nor has evidence
        result[nt] = { status: "Belum Tinjut", ...base };
      } catch {
        result[nt] = { status: "Belum Tinjut", ...base, lastStatus: "Gagal mengecek status" };
      }
    });

    await Promise.all(checks);
    sendResponse({ ok: true, data: result });
  } catch (e) {
    sendResponse({ ok: false, error: safeErrorMessage(e) });
  }
}