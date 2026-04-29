/**
 * PDF text extraction utility for the sidepanel context.
 *
 * pdf.js requires Workers + dynamic import(), which are blocked in Service Workers.
 * The sidepanel runs in a normal browser extension page context, so it has no
 * such restrictions. This module is imported ONLY by the sidepanel.
 *
 * Pages are extracted in parallel for maximum speed.
 */

import * as pdfjsLib from "pdfjs-dist";

// Worker URL — the pdf.worker.min.mjs file is in the extension root (public/)
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.mjs");

/**
 * Decode base64 → Uint8Array → extract text with pdf.js (pages in parallel).
 * maxPages caps how many pages are read (0 = all). Fewer pages = faster extraction
 * and less text sent to the LLM.
 */
export async function extractPdfFromBase64(base64: string, maxPages = 7): Promise<string> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const doc = await pdfjsLib.getDocument({
    data: bytes,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;

  const total = maxPages > 0 ? Math.min(doc.numPages, maxPages) : doc.numPages;

  const pageTexts = await Promise.all(
    Array.from({ length: total }, async (_, i) => {
      const page = await doc.getPage(i + 1);
      const content = await page.getTextContent();
      return content.items
        .filter((item) => "str" in item)
        .map((item) => (item as { str: string }).str)
        .join(" ")
        .trim();
    }),
  );

  return pageTexts.filter(Boolean).join("\n\n");
}
