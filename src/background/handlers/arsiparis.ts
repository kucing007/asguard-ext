/** Arsiparis (E-Arsip) handlers. */
import * as state from "../state";
import * as nadine from "../nadine-client";
import type { ArsipDocType } from "@/shared/types";

export async function handleArsipFetch(
  raw: { docType: ArsipDocType; startDate: string; endDate: string; perihal?: string; limit?: number },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  sendResponse(
    await state.runApi(async () => {
      const { docType, startDate, endDate, perihal, limit } = raw;
      let res: { Data?: unknown[] };
      if (docType === "konsep") res = await nadine.getArsipUnitUnarchived({ limit, startDate, endDate, perihal });
      else if (docType === "amplop") res = await nadine.getArsipAmplopUnarchived({ limit, startDate, endDate, perihal });
      else res = await nadine.getArsipDisposisiUnarchived({ limit, startDate, endDate, perihal });
      return res.Data ?? [];
    }),
  );
}

export async function handleArsipBerkasList(sendResponse: (r: unknown) => void): Promise<void> {
  sendResponse(
    await state.runApi(async () => {
      const res = await nadine.getListBerkas();
      return res.Data ?? [];
    }),
  );
}

export async function handleArsipBerkasCreate(
  raw: { klasifikasiArsipId: number; uraianBerkas: string; kurunWaktu: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  sendResponse(
    await state.runApi(() =>
      nadine.createBerkas({
        KlasifikasiArsipId: raw.klasifikasiArsipId,
        UraianBerkas: raw.uraianBerkas,
        KurunWaktu: raw.kurunWaktu,
      }),
    ),
  );
}

export async function handleArsipKlasifikasiFav(sendResponse: (r: unknown) => void): Promise<void> {
  sendResponse(
    await state.runApi(async () => {
      const res = await nadine.getRefKlasifikasiArsipFav();
      return res.Data ?? [];
    }),
  );
}

export async function handleArsipKlasifikasiAll(sendResponse: (r: unknown) => void): Promise<void> {
  sendResponse(
    await state.runApi(async () => {
      const res = await nadine.getRefKlasifikasiArsipAll();
      return res.Data ?? [];
    }),
  );
}

export async function handleArsipBulk(
  raw: { docType: ArsipDocType; berkasId: number; items: Array<{ Id: string; NdId: number }> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  sendResponse(await state.runApi(() => nadine.berkaskanMultiple(raw.docType, raw.berkasId, raw.items)));
}
