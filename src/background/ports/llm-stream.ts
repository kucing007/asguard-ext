/** LLM streaming port handler — summarize + chat. */
import * as nadine from "../nadine-client";
import { NadineNoTokenError, NadineHttpError } from "../nadine-client";
import * as llama from "../llama-client";
import * as cache from "../summary-cache";
import { buildSummaryMessages } from "@/shared/prompts";
import * as state from "../state";
import { debugLog, safeErrorMessage } from "@/shared/logging";
import type { LlmPortRequest, LlmStreamMsg, ChatMessage } from "@/shared/types";

const CHAT_SYSTEM_PROMPT = `Kamu adalah asisten yang membantu menganalisis naskah dinas (surat resmi pemerintah Indonesia).
Berikut adalah isi naskah yang sedang dibahas:

---
{NASKAH_CONTENT}
---

Jawab pertanyaan user berdasarkan isi naskah di atas. Gunakan bahasa Indonesia formal. Jika pertanyaan tidak terkait naskah, jawab sesuai kemampuanmu.`;

export function setupLlmStream(port: chrome.runtime.Port): void {
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
      debugLog("[asguard] detail response keys:", data ? Object.keys(data) : "no data");

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
            send({ type: "pdf/extract", base64, maxPages: state.llmSettings.maxPages ?? 7 });
          });
        }

        async function downloadAndExtract(pathOrUrl: string): Promise<string> {
          const bytes = await nadine.downloadFile(pathOrUrl);
          debugLog("[asguard] downloaded PDF bytes for extraction", { size: bytes.byteLength });
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
        const captured = state.capturedPdfs.get(ndId) ?? state.capturedPdfs.get("__latest__");
        if (captured && Date.now() - captured.capturedAt < 5 * 60 * 1000) {
          debugLog("[asguard] using captured PDF from page");
          send({ type: "llm/status", status: "Menggunakan PDF dari halaman…" });
          try {
            const extractedText = await askSidepanelExtract(captured.base64);
            debugLog("[asguard] extracted text from captured PDF", { chars: extractedText.length });
            if (extractedText.trim().length > 50) {
              naskahBody = extractedText;
              send({ type: "llm/status", status: `Berhasil mengekstrak ${extractedText.length} karakter dari dokumen` });
            }
          } catch (capturedErr) {
            console.warn("[asguard] captured PDF extraction failed:", safeErrorMessage(capturedErr));
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
            debugLog("[asguard] trying PathKonsep download", { hasPath: !!pathKonsep });
            send({ type: "llm/status", status: "Mengunduh dokumen PDF…" });
            try {
              const extractedText = await downloadAndExtract(pathKonsep);
              debugLog("[asguard] extracted text from PathKonsep", { chars: extractedText.length });
              if (extractedText.trim().length > 50) {
                naskahBody = extractedText;
                send({ type: "llm/status", status: `Berhasil mengekstrak ${extractedText.length} karakter` });
              }
            } catch (pdfErr) {
              console.warn("[asguard] PathKonsep download/extract failed:", safeErrorMessage(pdfErr));
            }
          }
        }

        // --- Strategy 2: Try lampiran downloads ---
        if (!naskahBody.trim()) {
          send({ type: "llm/status", status: "Memeriksa lampiran…" });
          try {
            const lampiran = await nadine.getAttachments(ndId);
            const lampList = lampiran.Data?.Lampiran ?? [];
            debugLog("[asguard] found lampiran", { count: lampList.length });

            for (const lamp of lampList.slice(0, 5)) {
              const dlPath = lamp.DownloadPath;
              if (!dlPath) continue;
              debugLog("[asguard] trying lampiran", { hasDownloadPath: !!dlPath });
              try {
                const lampText = await downloadAndExtract(dlPath);
                if (lampText.trim().length > 50) {
                  naskahBody += (naskahBody ? "\n\n" : "") + lampText;
                  send({ type: "llm/status", status: `Lampiran: ${lamp.NamaFile} (${lampText.length} kar)` });
                }
              } catch (lampErr) {
                console.warn("[asguard] lampiran failed:", safeErrorMessage(lampErr));
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
    const charLimit = state.llmSettings.maxInputChars ?? 4000;
    const body =
      charLimit > 0 && naskahBody.length > charLimit
        ? naskahBody.slice(0, Math.round(charLimit * 0.8)) + "\n…\n" + naskahBody.slice(-Math.round(charLimit * 0.2))
        : naskahBody;

    const messages = buildSummaryMessages(body, meta, state.llmSettings.systemPrompt || undefined);

    let fullText = "";
    try {
      for await (const chunk of llama.streamChat(state.llmSettings, messages, abortController.signal)) {
        fullText += chunk;
        send({ type: "llm/chunk", text: chunk });
      }
      if (fullText.trim()) {
        await cache.setCached(ndId, fullText);
      }
      state.naskahTextCache.set(ndId, { body: naskahBody, meta });
      send({ type: "llm/done" });
    } catch (e) {
      if (abortController.signal.aborted) return; // user navigated away
      const errMsg =
        e instanceof Error && e.message.includes("llama.cpp")
          ? e.message
          : `llama.cpp tidak terdeteksi di ${state.llmSettings.llamaUrl} — pastikan servernya berjalan.`;
      send({ type: "llm/error", error: errMsg });
    }
  });
}

async function handleChat(
  port: chrome.runtime.Port,
  msg: { ndId: string; history: ChatMessage[]; userMessage: string },
): Promise<void> {
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
  const cached = state.naskahTextCache.get(msg.ndId);
  if (cached) {
    naskahText = cached.body;
  } else {
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

  for (const h of msg.history) {
    llmMessages.push({ role: h.role, content: h.content });
  }
  llmMessages.push({ role: "user", content: msg.userMessage });

  // Stream response
  let fullText = "";
  try {
    for await (const chunk of llama.streamChat(state.llmSettings, llmMessages, abortController.signal)) {
      fullText += chunk;
      send({ type: "llm/chunk", text: chunk });
    }
    send({ type: "llm/done" });
  } catch (e) {
    if (abortController.signal.aborted) return;
    const errMsg =
      e instanceof Error && e.message.includes("llama.cpp")
        ? e.message
        : `llama.cpp tidak terdeteksi di ${state.llmSettings.llamaUrl} — pastikan servernya berjalan.`;
    send({ type: "llm/error", error: errMsg });
  }
}
