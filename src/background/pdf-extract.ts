/**
 * Extract text from a PDF ArrayBuffer using pdf.js.
 * Runs in the service worker context.
 */

import * as pdfjsLib from "pdfjs-dist";

// Point to the worker file bundled in the extension's public/ directory
// chrome.runtime.getURL resolves to chrome-extension://ID/pdf.worker.min.mjs
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.mjs");

/**
 * Extract all text from a PDF file.
 * @param pdfBytes - The PDF as an ArrayBuffer or Uint8Array
 * @returns Concatenated text from all pages, separated by newlines
 */
export async function extractTextFromPdf(pdfBytes: ArrayBuffer | Uint8Array): Promise<string> {
  const data = pdfBytes instanceof ArrayBuffer ? new Uint8Array(pdfBytes) : pdfBytes;

  const doc = await pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;

  const pages: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .filter((item) => "str" in item)
      .map((item) => (item as { str: string }).str)
      .join(" ");
    if (pageText.trim()) {
      pages.push(pageText.trim());
    }
  }

  return pages.join("\n\n");
}
