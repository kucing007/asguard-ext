/**
 * Summary system prompt and message builder for naskah dinas.
 * Used by the background service worker when streaming to llama.cpp.
 */

export const SUMMARY_SYSTEM_PROMPT = `Kamu adalah asisten ringkasan naskah dinas (surat resmi pemerintah Indonesia).

Ketika diberi isi naskah dinas, berikan:
1. **Ringkasan** — 2-3 kalimat inti dari naskah.
2. **Poin Penting** — daftar bullet poin utama (maks 5).
3. **Tindakan** — jika ada permintaan tindakan/arahan, sebutkan. Jika tidak ada, tulis "Tidak ada tindakan spesifik."

Format output HARUS markdown. Gunakan bahasa Indonesia formal. Jangan menambahkan informasi yang tidak ada dalam naskah.`;

export interface NaskahMeta {
  noNd?: string;
  perihal?: string;
  pengirim?: string;
  tanggal?: string;
}

export function buildKlasifikasiMessages(
  naskahText: string,
  perihal: string,
  klasOptions: string,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: `Kamu adalah sistem klasifikasi dokumen arsip pemerintah Indonesia.
Tugasmu: pilih SATU kode klasifikasi arsip yang paling tepat dari daftar yang diberikan.
RESPONS HANYA dengan kode klasifikasi (contoh: HK.02.03). Tidak ada penjelasan tambahan.`,
    },
    {
      role: "user",
      content: `Perihal: ${perihal.slice(0, 300)}\n\nIsi dokumen:\n${naskahText.slice(0, 2000)}\n\nDaftar klasifikasi:\n${klasOptions.slice(0, 3000)}\n\nKode klasifikasi yang paling tepat:`,
    },
  ];
}

export function buildSummaryMessages(
  naskahBody: string,
  metadata?: NaskahMeta,
  customSystemPrompt?: string,
): Array<{ role: "system" | "user"; content: string }> {
  const systemPrompt = customSystemPrompt?.trim() || SUMMARY_SYSTEM_PROMPT;

  let userContent = "";
  if (metadata) {
    const parts: string[] = [];
    if (metadata.noNd) parts.push(`No ND: ${metadata.noNd}`);
    if (metadata.perihal) parts.push(`Perihal: ${metadata.perihal}`);
    if (metadata.pengirim) parts.push(`Pengirim: ${metadata.pengirim}`);
    if (metadata.tanggal) parts.push(`Tanggal: ${metadata.tanggal}`);
    if (parts.length) userContent += parts.join(" | ") + "\n\n";
  }
  userContent += naskahBody;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}
