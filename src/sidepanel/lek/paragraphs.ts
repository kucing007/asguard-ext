import { bodyParagraphs, paraText, setParaText } from "./docx-xml";

const PREFIX_MAP: Array<[key: "nomor" | "tanggal" | "paket" | "kinerja", prefix: string]> = [
  ["nomor", "Nomor"],
  ["tanggal", "Tanggal"],
  ["paket", "No Paket Evaluasi"],
  ["kinerja", "Kinerja Paket Evaluasi"],
];

/**
 * Copy Nomor / Tanggal / No Paket Evaluasi / Kinerja Paket Evaluasi / Surat Tugas
 * header paragraphs from the datasource into the matching template paragraphs.
 * (update_dynamic_paragraphs)
 */
export function updateDynamicParagraphs(tmplDoc: Document, dsDoc: Document): string[] {
  const dsValues: Partial<Record<"nomor" | "tanggal" | "paket" | "kinerja" | "surat_tugas", string>> = {};
  for (const p of bodyParagraphs(dsDoc)) {
    const text = paraText(p).trim();
    if (text.startsWith("Nomor")) dsValues["nomor"] = text;
    else if (text.startsWith("Tanggal")) dsValues["tanggal"] = text;
    else if (text.startsWith("No Paket Evaluasi")) dsValues["paket"] = text;
    else if (text.startsWith("Kinerja Paket Evaluasi")) dsValues["kinerja"] = text;
    else if (text.includes("Surat Tugas") && text.includes("Kepala")) dsValues["surat_tugas"] = text;
  }

  const updated: string[] = [];
  for (const p of bodyParagraphs(tmplDoc)) {
    const text = paraText(p).trim();
    let matched = false;
    for (const [key, prefix] of PREFIX_MAP) {
      if (text.startsWith(prefix) && dsValues[key] !== undefined) {
        setParaText(p, dsValues[key]!);
        updated.push(prefix);
        matched = true;
        break;
      }
    }
    if (
      !matched &&
      text.includes("Surat Tugas") &&
      text.includes("Kepala") &&
      dsValues["surat_tugas"] !== undefined
    ) {
      setParaText(p, dsValues["surat_tugas"]!);
      updated.push("Surat Tugas");
    }
  }
  return updated;
}
