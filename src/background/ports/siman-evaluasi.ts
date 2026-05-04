/** SIMAN Evaluasi BMN batch automation — mirrors CLI evaluasi.py run_automation with detailed logging. */
import * as simanClient from "../siman-client";
import * as simanStore from "../siman-store";
import type { SimanEvalPortRequest, SimanEvalMsg } from "@/shared/siman-types";

const IND_COLS = ["111111","121111","121211","121311","121411","121511","131111","131211","131311","131411","131511","131611","131711","141111","141211","151211","151212","151213","151214","151215","161111"];
const PILIHAN = new Set(["111111","131111","131211","131311","131411","131511","131611","131711","141111","141211","161111"]);
const ANGKA = new Set(["121111","121211","121311","121411","121511","151211","151212","151213","151214","151215"]);

export function setupSimanEvaluasi(port: chrome.runtime.Port): void {
  port.onMessage.addListener(async (msg: SimanEvalPortRequest) => {
    if (msg.type !== "siman/eval-run") return;
    const { role, fullname } = simanStore.getSimanToken();
    if (!role) { p({ type: "eval/error", error: "No SIMAN role" }); return; }
    const uid = Number(role.idUser) || 0;
    const nm = fullname ?? "";

    function p(m: SimanEvalMsg) { try { port.postMessage(m); } catch { /* */ } }
    function log(s: string) { p({ type: "eval/log", message: s }); }
    function ok(res: Record<string, unknown>): boolean { return res.status === 200 || res.msg === "success" || res.msg === "Data Has Updated" || res.msg === "Data Has Created" || String(res.msg ?? "").toLowerCase().includes("success") || String(res.msg ?? "").toLowerCase().includes("created"); }
    function d0(res: Record<string, unknown>): Record<string, unknown> { const d = res.data; return Array.isArray(d) && d.length ? d[0] as Record<string, unknown> : res; }
    const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

    try {
      log("Mengambil daftar aset…");
      const asetList = await simanClient.getAsetByPaket(msg.noPaket);
      log(`${asetList.length} aset ditemukan`);

      const asetMap = new Map<string, Record<string, unknown>>();
      for (const a of asetList) asetMap.set(`${String(a.kd_brg ?? "").replace(/\./g, "")}|${a.no_aset}`, a);

      const matched: { aset: Record<string, unknown>; row: Record<string, string> }[] = [];
      for (const row of msg.excelRows) {
        const key = `${String(row.kd_brg ?? "").replace(/\./g, "")}|${row.no_aset ?? ""}`;
        const aset = asetMap.get(key);
        if (aset) matched.push({ aset, row });
        else log(`⚠ Tidak cocok: kd_brg=${row.kd_brg} no_aset=${row.no_aset}`);
      }
      log(`${matched.length}/${msg.excelRows.length} baris cocok`);
      if (!matched.length) { p({ type: "eval/done", success: 0, failed: 0 }); return; }

      // Pre-fetch refs
      log("Mengambil referensi interval & bobot…");
      const intv = d0(await simanClient.getInterval() as unknown as Record<string, unknown>);
      const bob = d0(await simanClient.getBobotAktif() as unknown as Record<string, unknown>);
      log(`interval0=${intv.id_interval0}, bobot=${bob.id_bobot}`);

      let success = 0, failed = 0;

      for (let i = 0; i < matched.length; i++) {
        const { aset, row } = matched[i];
        const id = String(aset.id_siap_bmn);
        const kd = String(aset.kd_brg ?? "");
        log(`\n━━━ Aset ${i + 1}/${matched.length}: ${kd} NUP ${aset.no_aset} ━━━`);
        p({ type: "eval/aset-progress", done: i, total: matched.length, kdBrg: kd, step: "Mulai" });

        try {
          // 1. Cara Evaluasi
          const cara = (row.cara_evaluasi ?? "").trim();
          if (cara) {
            log(`  [1/9] Cara Evaluasi → ${cara}`);
            const r = await simanClient.editEvaluasi({ id_siap_bmn: id, cara_evaluasi: cara, created_by: uid, updated_by: uid, edited_by: uid, no_paket: aset.no_paket, tahun: aset.tahun ?? new Date().getFullYear(), status_proses: "Update Aset Evaluasi", status_ket: "Update Cara Evaluasi Aset", id_user: uid, nm_pengguna: nm, tgl_create: now() }) as Record<string, unknown>;
            log(`  [1/9] ${ok(r) ? "✓" : "✗ " + String(r.msg ?? r.status)}`);
          } else log("  [1/9] Cara Evaluasi → ⏭ kosong");

          // 2. Tanggal Survey
          const tgl = (row.tgl_survey ?? "").trim();
          if (tgl) {
            log(`  [2/9] Tgl Survey → ${tgl}`);
            const r = await simanClient.editSurvey({ id_siap_bmn: id, tgl_survey: tgl, created_by: uid, updated_by: uid, edited_by: uid, status_data: 1, stat_data: "Y", no_paket: aset.no_paket, tahun: aset.tahun ?? new Date().getFullYear(), status_proses: "Update Aset Evaluasi", status_ket: "Update Tanggal Survey Evaluasi Aset", id_user: uid, nm_pengguna: nm, tgl_create: now() }) as Record<string, unknown>;
            log(`  [2/9] ${ok(r) ? "✓" : "✗ " + String(r.msg ?? r.status)}`);
          } else log("  [2/9] Tgl Survey → ⏭ kosong");

          // 3. Generate Indikator 15
          log("  [3/9] Generate Indikator 15");
          try {
            const r = await simanClient.generate15({ created_by: uid, updated_by: uid, edited_by: uid, id_siap_bmn: id, no_paket: aset.no_paket, tahun: aset.tahun ?? new Date().getFullYear(), id_aset: aset.id_aset, id_satker: aset.id_satker, id_kpknl: aset.id_kpknl ?? (Number(role.idKpknl) || 0), ur_kpknl: aset.ur_kpknl ?? "", id_kanwil: aset.id_kanwil, kd_jns_bmn: aset.kd_jns_bmn, kd_peruntukan: aset.kd_peruntukan ?? "P1", ur_peruntukan: aset.ur_peruntukan ?? "KANTOR", kd_satker: aset.kd_satker ?? "", ur_satker: aset.ur_satker ?? "", kd_brg: kd, no_aset: aset.no_aset, ur_sskel: aset.ur_sskel ?? "", id_user: uid, tgl_create: now(), status_proses: "N", stat_data: "Y", id_interval0: intv.id_interval0 ?? 133, ur_sub: "Aset Non Komersial", id_pembobotan: Number(bob.id_bobot ?? 128) }) as Record<string, unknown>;
            log(`  [3/9] ${ok(r) ? "✓" : "✗ " + String(r.msg ?? r.status)}`);
          } catch (e) { log(`  [3/9] ✗ ${e instanceof Error ? e.message : e}`); }

          // 4. Update indikators from Excel
          log("  [4/9] Indikator:");
          const laksana = await simanClient.getLaksana(id);
          const lkMap = new Map<string, Record<string, unknown>>();
          for (const lk of laksana) { const k = String(lk.kd_sub_sub ?? ""); if (k) lkMap.set(k, lk); }
          log(`        ${laksana.length} laksana items loaded`);

          for (const kdCol of IND_COLS) {
            const cell = (row[kdCol] ?? "").trim().replace(/^@\s*/, "");
            const lk = lkMap.get(kdCol);
            if (!lk) continue;
            if (!cell) { log(`        ${kdCol} → ⏭ kosong`); continue; }

            try {
              if (PILIHAN.has(kdCol)) {
                const refs = await simanClient.getRefSkor(kdCol);
                const ref = refs.find((r: Record<string, unknown>) => String(r.nilai ?? "").trim().toLowerCase() === cell.toLowerCase()) ?? refs.find((r: Record<string, unknown>) => { const n = String(r.nilai ?? "").trim().toLowerCase(); return cell.toLowerCase().includes(n) || n.includes(cell.toLowerCase()); });
                if (!ref) { log(`        ${kdCol} → ✗ ref not found: "${cell}"`); continue; }
                const skor = Number(ref.skor ?? 0);
                const color = skor > 0 ? String(d0(await simanClient.getKonversiSkor(skor) as Record<string, unknown>).ket ?? "-") : "-";
                const r = await simanClient.editLaksana(bld(lk, { nilai_sub_sub2: ref.nilai, skor, score_color: color })) as Record<string, unknown>;
                log(`        ${kdCol} → ${ref.nilai} (skor:${skor}, ${color}) ${ok(r) ? "✓" : "✗"}`);
              } else if (ANGKA.has(kdCol)) {
                const nilai = parseFloat(cell);
                if (isNaN(nilai)) { log(`        ${kdCol} → ✗ bukan angka: "${cell}"`); continue; }
                const isT = kdCol === "121411";
                const idxRes = isT ? await simanClient.getIndeksSkorTerbalik(kdCol, nilai) : await simanClient.getIndeksSkorLurus(kdCol, nilai);
                const idxData = (idxRes as Record<string, unknown>).data;
                const skor = Array.isArray(idxData) && idxData.length ? Number((idxData[idxData.length - 1] as Record<string, unknown>).skor ?? 0) : 0;
                const color = skor > 0 ? String(d0(await simanClient.getKonversiSkor(skor) as Record<string, unknown>).ket ?? "-") : "-";
                const r = await simanClient.editLaksana(bld(lk, { nilai_sub_sub: nilai, skor, score_color: color })) as Record<string, unknown>;
                log(`        ${kdCol} → ${nilai} (skor:${skor}, ${color}) ${ok(r) ? "✓" : "✗"}`);
              }
            } catch (e) {
              log(`        ${kdCol} → ✗ Error: ${e instanceof Error ? e.message : e}`);
            }
          }

          // 5. Calculate 151216
          const lk216 = lkMap.get("151216");
          if (lk216) {
            try {
              log("  [5/9] Hitung 151216");
              const fresh = await simanClient.getLaksana(id);
              const v: Record<string, number> = {};
              for (const l of fresh) { const k = String(l.kd_sub_sub ?? ""); if (["151212","151213","151214","151215"].includes(k)) v[k] = Number(l.nilai_sub_sub ?? 0) || 0; }
              const num = kd.startsWith("2") ? (v["151213"]??0)+(v["151214"]??0) : (v["151212"]??0)+(v["151213"]??0)+(v["151214"]??0);
              const sewa = v["151215"] ?? 0;
              let nilai = 0, skor = 0, warna = "Abu-abu";
              if (sewa > 0 && num > 0) { nilai = num / sewa; skor = nilai < 1 ? 8 : 3; warna = nilai < 1 ? "Hijau" : "Merah"; }
              const r = await simanClient.editLaksana(bld(lk216, { nilai_sub_sub: nilai, skor, score_color: warna })) as Record<string, unknown>;
              log(`  [5/9] nilai=${nilai.toFixed(4)} skor=${skor} ${warna} ${ok(r) ? "✓" : "✗"}`);
            } catch (e) { log(`  [5/9] ✗ ${e instanceof Error ? e.message : e}`); }
          } else log("  [5/9] 151216 → ⏭ tidak ada");

          // 6. Edit Subsub
          log("  [6/9] Edit Subsub");
          const laksInd = await simanClient.getLaksanaIndikator(id);
          let ssOk = 0, ssFail = 0;
          for (const ind of laksInd) {
            const lid = String(ind.id_laks_ind ?? "");
            if (!lid) continue;
            try { const r = await simanClient.editSubsub(lid) as Record<string, unknown>; if (ok(r)) ssOk++; else ssFail++; } catch { ssFail++; }
          }
          log(`  [6/9] ${ssOk} OK, ${ssFail} gagal`);

          // 7. Hitung Score Card BMN (2x)
          log("  [7/9] Score Card BMN (2x iteration)");
          const seen = new Set<string>();
          const ids: string[] = [];
          for (const l of laksana) { const lid = String(l.id_laks_ind ?? ""); if (lid && !seen.has(lid)) { seen.add(lid); ids.push(lid); } }
          let results: { warna: string }[] = [];
          for (let iter = 0; iter < 2; iter++) {
            results = [];
            for (const lid of ids) {
              const jml = Number(d0(await simanClient.getCountUs(lid) as Record<string, unknown>).jml_hitung ?? 0);
              let w = jml >= 4 ? "green" : "red";
              if (jml > 0) { try { const ket = String(d0(await simanClient.getKonversiSkor(jml) as Record<string, unknown>).ket ?? "").toLowerCase(); if (ket === "hijau") w = "green"; else if (ket === "merah") w = "red"; } catch { /* */ } }
              await simanClient.editSkorAkhir(lid, jml, w);
              results.push({ warna: w });
              if (iter === 1) log(`        ${lid.slice(0, 8)}… jml=${jml} → ${w}`);
            }
          }
          let h = 0, m = 0, a = 0;
          for (const r of results) { if (r.warna === "green") h++; else if (r.warna === "red") m++; else a++; }
          const kinerja = h === 6 ? "BAIK SEKALI" : a > 2 ? "INVALID" : h > m ? "BAIK" : "BURUK";
          log(`  [7/9] Hijau=${h} Merah=${m} Abu=${a} → ${kinerja}`);

          // 8. Update Status Nilai
          log("  [8/9] Update Status Nilai");
          const r8 = await simanClient.updateStatusNilai({ no_paket: aset.no_paket, stat_nil_bmn: "Y", created_by: uid, updated_by: uid, edited_by: uid, tahun: aset.tahun ?? new Date().getFullYear(), status_proses: "Score Card BMN", status_ket: "Melakukan Perhitungan Score Card BMN", id_user: uid, nm_pengguna: nm, tgl_create: now() }) as Record<string, unknown>;
          log(`  [8/9] ${ok(r8) ? "✓" : "✗ " + String(r8.msg ?? r8.status)}`);

          // 9. Status → SELESAI
          log(`  [9/9] Status → SELESAI (${kinerja})`);
          const r9 = await simanClient.editStatus(id, kinerja) as Record<string, unknown>;
          log(`  [9/9] ${ok(r9) ? "✓" : "✗ " + String(r9.msg ?? r9.status)}`);

          success++;
          p({ type: "eval/aset-done", done: i + 1, total: matched.length, kinerja });
          log(`  ✅ Selesai → ${kinerja}`);
        } catch (e) {
          failed++;
          log(`  ❌ Error: ${e instanceof Error ? e.message : e}`);
          p({ type: "eval/aset-done", done: i + 1, total: matched.length, kinerja: "ERROR" });
        }
      }
      log(`\n━━━ SELESAI: ${success} berhasil, ${failed} gagal ━━━`);
      p({ type: "eval/done", success, failed });
    } catch (e) {
      log(`❌ Fatal: ${e instanceof Error ? e.message : e}`);
      p({ type: "eval/error", error: e instanceof Error ? e.message : String(e) });
    }
  });
}

function bld(lk: Record<string, unknown>, o: { nilai_sub_sub?: number; nilai_sub_sub2?: unknown; skor: number; score_color: string }): Record<string, unknown> {
  const p: Record<string, unknown> = { id_laksana: lk.id_laksana, id_laks_ind: lk.id_laks_ind, no_paket: lk.no_paket, kd_sub_sub_indikator: lk.kd_sub_sub, ur_sub_sub: lk.ur_sub_sub, ur_sub_indikator: lk.ur_sub_sub, ur_indikator: lk.ur_sub_sub, status_na_nu: "US", skor: String(o.skor), ket_na_nu: null, score_color: o.score_color, status_proses: "Y" };
  if (o.nilai_sub_sub2 !== undefined) p.nilai_sub_sub2 = o.nilai_sub_sub2;
  if (o.nilai_sub_sub !== undefined) p.nilai_sub_sub = o.nilai_sub_sub;
  return p;
}
