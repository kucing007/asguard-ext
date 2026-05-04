/**
 * Message and port dispatcher — thin router that delegates to domain handlers.
 */
import type { BgMessage, PanelRequest } from "@/shared/types";
import * as state from "./state";
import * as nadineAuth from "./handlers/nadine-auth";
import * as simanAuth from "./handlers/siman-auth";
import * as settings from "./handlers/settings";
import * as templates from "./handlers/templates";
import * as arsiparis from "./handlers/arsiparis";
import * as siman from "./handlers/siman";
import * as license from "./handlers/license";
import * as updateClient from "./update-client";
import * as llmStream from "./ports/llm-stream";
import * as templateRun from "./ports/template-run";
import * as mailMergeRun from "./ports/mail-merge-run";
import * as arsipRun from "./ports/arsip-run";
import * as simanRun from "./ports/siman-run";
import * as simanDokLengkap from "./ports/siman-dok-lengkap";
import * as simanSopTarik from "./ports/siman-sop-tarik";
import * as simanEvaluasi from "./ports/siman-evaluasi";

export function setupRouter(ready: Promise<void>): void {
  // --- Request/response messages ---
  chrome.runtime.onMessage.addListener(
    (raw: BgMessage | PanelRequest, _sender, sendResponse) => {
      (async () => {
        await ready;

        // --- Content script messages ---
        if (raw.type === "token/capture") {
          await nadineAuth.handleTokenCapture(raw, sendResponse);
          return;
        }
        if (raw.type === "page/changed") {
          await nadineAuth.handlePageChanged(raw, sendResponse);
          return;
        }
        if (raw.type === "viewing/ndId") {
          await nadineAuth.handleViewingNdId(raw, sendResponse);
          return;
        }
        if (raw.type === "pdf/captured") {
          await nadineAuth.handlePdfCaptured(raw, sendResponse);
          return;
        }
        if (raw.type === "naskah/created") {
          await nadineAuth.handleNaskahCreated(raw, sendResponse);
          return;
        }
        if (raw.type === "siman/token") {
          await simanAuth.handleSimanToken(raw, sendResponse);
          return;
        }
        if (raw.type === "siman/role-data") {
          await simanAuth.handleSimanRoleData(raw, sendResponse);
          return;
        }

        // --- Panel requests ---
        if (raw.type === "state/get") {
          sendResponse(state.snapshot());
          return;
        }
        if (raw.type === "token/clear") {
          await nadineAuth.handleTokenClear(sendResponse);
          return;
        }
        if (raw.type === "api/counts") {
          await nadineAuth.handleApiCounts(sendResponse);
          return;
        }
        if (raw.type === "api/naskah") {
          await nadineAuth.handleApiNaskah(raw, sendResponse);
          return;
        }
        if (raw.type === "api/me") {
          await nadineAuth.handleApiMe(sendResponse);
          return;
        }
        if (raw.type === "api/switch-role") {
          await nadineAuth.handleSwitchRole(raw, sendResponse);
          return;
        }

        // Settings
        if (raw.type === "settings/get") {
          await settings.handleSettingsGet(sendResponse);
          return;
        }
        if (raw.type === "settings/set") {
          await settings.handleSettingsSet(raw, sendResponse);
          return;
        }
        if (raw.type === "llm/health") {
          await settings.handleLlmHealth(sendResponse);
          return;
        }
        if (raw.type === "cache/clear") {
          await settings.handleCacheClear(sendResponse);
          return;
        }

        // Templates
        if (raw.type === "template/list") {
          await templates.handleTemplateList(sendResponse);
          return;
        }
        if (raw.type === "template/get") {
          await templates.handleTemplateGet(raw, sendResponse);
          return;
        }
        if (raw.type === "template/save") {
          await templates.handleTemplateSave(raw, sendResponse);
          return;
        }
        if (raw.type === "template/update") {
          await templates.handleTemplateUpdate(raw, sendResponse);
          return;
        }
        if (raw.type === "template/delete") {
          await templates.handleTemplateDelete(raw, sendResponse);
          return;
        }
        if (raw.type === "template/pending") {
          await templates.handleTemplatePending(sendResponse);
          return;
        }
        if (raw.type === "template/units") {
          await templates.handleTemplateUnits(raw, sendResponse);
          return;
        }

        // Arsiparis
        if (raw.type === "arsip/fetch") {
          await arsiparis.handleArsipFetch(raw, sendResponse);
          return;
        }
        if (raw.type === "arsip/berkas-list") {
          await arsiparis.handleArsipBerkasList(sendResponse);
          return;
        }
        if (raw.type === "arsip/berkas-create") {
          await arsiparis.handleArsipBerkasCreate(raw, sendResponse);
          return;
        }
        if (raw.type === "arsip/klasifikasi-fav") {
          await arsiparis.handleArsipKlasifikasiFav(sendResponse);
          return;
        }
        if (raw.type === "arsip/klasifikasi-all") {
          await arsiparis.handleArsipKlasifikasiAll(sendResponse);
          return;
        }
        if (raw.type === "arsip/bulk") {
          await arsiparis.handleArsipBulk(raw, sendResponse);
          return;
        }

        // SIMAN panel
        if (raw.type === "siman/state") {
          await siman.handleSimanState(sendResponse);
          return;
        }
        if (raw.type === "siman/token-clear") {
          await siman.handleSimanTokenClear(sendResponse);
          return;
        }
        if (raw.type === "siman/penetapan-body") {
          await siman.handleSimanPenetapanBody(raw, sendResponse);
          return;
        }
        if (raw.type === "siman/get-roles") {
          await siman.handleSimanGetRoles(sendResponse);
          return;
        }
        if (raw.type === "siman/set-role") {
          await siman.handleSimanSetRole(raw, sendResponse);
          return;
        }
        if (raw.type === "siman/get-tipe-pengelolaan") {
          await siman.handleSimanGetTipePengelolaan(sendResponse);
          return;
        }
        if (raw.type === "siman/get-penetapan-list") {
          await siman.handleSimanGetPenetapanList(raw, sendResponse);
          return;
        }
        if (raw.type === "siman/get-penetapan-detail") {
          await siman.handleSimanGetPenetapanDetail(raw, sendResponse);
          return;
        }
        if (raw.type === "siman/get-kelengkapan") {
          await siman.handleSimanGetKelengkapan(raw, sendResponse);
          return;
        }
        if (raw.type === "siman/get-download-token") {
          await siman.handleSimanGetDownloadToken(raw, sendResponse);
          return;
        }
        if (raw.type === "siman/get-kanwil-list") {
          await siman.handleSimanGetKanwilList(sendResponse);
          return;
        }
        if (raw.type === "siman/get-kpknl-list") {
          await siman.handleSimanGetKpknlList(sendResponse);
          return;
        }
        if (raw.type === "siman/get-templates") {
          await siman.handleSimanGetTemplates(sendResponse);
          return;
        }
        if (raw.type === "siman/save-template") {
          await siman.handleSimanSaveTemplate(raw, sendResponse);
          return;
        }
        if (raw.type === "siman/template-update") {
          await siman.handleSimanTemplateUpdate(raw, sendResponse);
          return;
        }
        if (raw.type === "siman/delete-template") {
          await siman.handleSimanDeleteTemplate(raw, sendResponse);
          return;
        }

        // Evaluasi BMN
        if (raw.type === "eval/paket-list") {
          await siman.handleEvalPaketList(raw, sendResponse);
          return;
        }
        if (raw.type === "eval/aset-list") {
          await siman.handleEvalAsetList(raw, sendResponse);
          return;
        }
        if (raw.type === "eval/laksana") {
          await siman.handleEvalLaksana(raw, sendResponse);
          return;
        }
        if (raw.type === "eval/ref-skor") {
          await siman.handleEvalRefSkor(raw, sendResponse);
          return;
        }
        if (raw.type === "eval/edit-evaluasi") {
          await siman.handleEvalEditEvaluasi(raw, sendResponse);
          return;
        }
        if (raw.type === "eval/edit-survey") {
          await siman.handleEvalEditSurvey(raw, sendResponse);
          return;
        }
        if (raw.type === "eval/edit-status") {
          await siman.handleEvalEditStatus(raw, sendResponse);
          return;
        }
        if (raw.type === "eval/edit-laksana") {
          await siman.handleEvalEditLaksana(raw, sendResponse);
          return;
        }
        if (raw.type === "eval/generate15") {
          await siman.handleEvalGenerate15(raw, sendResponse);
          return;
        }

        // License
        if (raw.type === "license/check") {
          await license.handleLicenseCheck(sendResponse);
          return;
        }
        if (raw.type === "license/clear-cache") {
          await license.handleLicenseClearCache(sendResponse);
          return;
        }

        // Update
        if (raw.type === "update/check") {
          sendResponse(await updateClient.checkForUpdate());
          return;
        }
        if (raw.type === "update/get-cached") {
          sendResponse(await updateClient.getCachedUpdate());
          return;
        }

        // Backup
        if (raw.type === "backup/export") {
          const keys = ["asguard.templates", "asguard.simanTemplates", "asguard.llmSettings"];
          const data = await chrome.storage.local.get(keys);
          sendResponse({ ok: true, data });
          return;
        }
        if (raw.type === "backup/import") {
          await chrome.storage.local.set(raw.data);
          await state.loadSettings();
          state.broadcastState();
          sendResponse({ ok: true });
          return;
        }
      })();
      return true; // keep channel open for async
    },
  );

  // --- Port-based streaming ---
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "template-run") {
      templateRun.setupTemplateRun(port);
      return;
    }
    if (port.name === "mail-merge-run") {
      mailMergeRun.setupMailMergeRun(port);
      return;
    }
    if (port.name === "arsip-run") {
      arsipRun.setupArsipRun(port);
      return;
    }
    if (port.name === "siman-run") {
      simanRun.setupSimanRun(port);
      return;
    }
    if (port.name === "siman-dok-lengkap") {
      simanDokLengkap.setupSimanDokLengkap(port);
      return;
    }
    if (port.name === "siman-sop-tarik") {
      simanSopTarik.setupSimanSopTarik(port);
      return;
    }
    if (port.name === "siman-evaluasi") {
      simanEvaluasi.setupSimanEvaluasi(port);
      return;
    }
    if (port.name === "llm-stream") {
      llmStream.setupLlmStream(port);
      return;
    }
  });
}
