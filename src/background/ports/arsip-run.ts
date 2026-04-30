/** Arsiparis auto-archive port handler. */
import * as nadine from "../nadine-client";
import * as llama from "../llama-client";
import { buildKlasifikasiMessages } from "@/shared/prompts";
import * as state from "../state";
import type { ArsipBerkas, ArsipDocType, ArsipGroup, ArsipPortMsg, ArsipProgressMsg } from "@/shared/types";

export function setupArsipRun(port: chrome.runtime.Port): void {
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
      const waitForConfirm = () => new Promise<void>((r) => {
        confirmResolve = r;
      });
      const askPanel = (base64: string, ndId: number): Promise<string> =>
        new Promise<string>((resolve) => {
          pdfResolve = resolve;
          const send = (m: ArsipProgressMsg) => {
            try { port.postMessage(m); } catch { /* port closed */ }
          };
          send({ type: "arsip/pdf-extract", base64, maxPages: 3, ndId });
          setTimeout(() => {
            if (pdfResolve) {
              pdfResolve = null;
              resolve("");
            }
          }, 20_000);
        });
      await runAutoArsip(msg.docType, msg.startDate, msg.endDate, (m) => {
        try { port.postMessage(m); } catch { /* port closed */ }
      }, waitForConfirm, () => aborted, !!msg.useAI, askPanel);
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
): Promise<void> {
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

  send({ type: "arsip/status", message: useAI
    ? `${rawItems.length} naskah ditemukan. Memuat daftar klasifikasi untuk AI...`
    : `${rawItems.length} naskah ditemukan. Menganalisis klasifikasi otomatis berdasarkan klasifikasi awal...` });

  // Pre-load klasifikasi reference
  const klasRef = new Map<string, { Id: number; Nama: string }>();
  let klasOptions = "";
  if (useAI) {
    try {
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
    } catch {
      /* proceed */
    }
    try {
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
    } catch {
      /* proceed without LLM */
    }
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
          send({ type: "arsip/status", message: `Menganalisis klasifikasi dengan AI… (${i + 1}/${rawItems.length}) ${perihal || `NdId ${ndId}`}` });
          let llmKode = "";
          try {
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
              } catch {
                /* PDF failed, fall back to perihal */
              }
            }
            const msgs = buildKlasifikasiMessages(naskahText, perihal, klasOptions);
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 30_000);
            let raw = "";
            try {
              for await (const chunk of llama.streamChat(
                { ...state.llmSettings, maxTokens: 50, temperature: 0.0 },
                msgs,
                ctrl.signal,
              )) raw += chunk;
            } finally {
              clearTimeout(timer);
            }
            const match = raw.match(/\b([A-Z]{2}\.\d{2}(?:\.\d{2})*)\b/);
            if (match && klasRef.has(match[1])) llmKode = match[1];
          } catch {
            /* fall back to meta kode */
          }
          kode = llmKode || metaKode;
        } else {
          kode = metaKode;
        }
      } catch {
        /* no kode */
      }
    } else {
      send({ type: "arsip/classify-progress", done: i + 1, total: rawItems.length });
    }
    classified.push({ item, kode });
    await state.sleep(80);
  }

  if (isAborted()) return;

  // 3. Group by KodeKlasifikasi
  const groupMap = new Map<string, Record<string, unknown>[]>();
  let skippedCount = 0;
  for (const { item, kode } of classified) {
    if (!kode) {
      skippedCount++;
      continue;
    }
    const arr = groupMap.get(kode) ?? [];
    arr.push(item);
    groupMap.set(kode, arr);
  }

  // 4. Load berkas list
  let berkasList: ArsipBerkas[] = [];
  try {
    const bRes = await nadine.getListBerkas({ berkasAktif: 1 });
    berkasList = (bRes.Data ?? []) as ArsipBerkas[];
  } catch {
    /* proceed */
  }

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

  // 7. If non-AI mode, load klasRef now
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
    } catch {
      /* proceed */
    }
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
          await nadine.createBerkas({
            KlasifikasiArsipId: ref.Id,
            UraianBerkas: `Berkaitan dengan ${ref.Nama}.`,
            KurunWaktu: year,
          });
          await state.sleep(500);
          const newBRes = await nadine.getListBerkas({ berkasAktif: 1 });
          for (const b of (newBRes.Data ?? []) as ArsipBerkas[]) {
            if (b.KlasifikasiArsip?.KodeKlasifikasi === kode && String(b.KurunWaktu) === year) {
              berkasId = b.Id;
              berkasMap.set(kode, berkasId);
              createdCount++;
              break;
            }
          }
        } catch {
          /* failed to create */
        }
      }
    }

    if (!berkasId) {
      failed += items.length;
      send({ type: "arsip/group-step", index: gi, total: groupArr.length, kode, step: "Gagal — berkas tidak ditemukan" });
      continue;
    }

    send({ type: "arsip/group-step", index: gi, total: groupArr.length, kode, step: `Mengarsipkan ${items.length} naskah...` });
    try {
      const archItems = items.map((it) => ({
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
    await state.sleep(300);
  }

  send({ type: "arsip/complete", success, skipped: skippedCount, created: createdCount, failed });
}
