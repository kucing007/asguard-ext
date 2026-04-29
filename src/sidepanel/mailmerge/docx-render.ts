import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SENTINEL = "[[MM_PH_";
const SENTINEL_END = "_MM]]";
function sentinelFor(ph: string) { return `${SENTINEL}${ph}${SENTINEL_END}`; }

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}

/**
 * Render a docx template with data substitution.
 * Uses single-brace {placeholder} syntax.
 * If a value contains ";", the placeholder's containing table row or numbered
 * list paragraph is cloned once per value. In regular paragraphs, values become
 * line breaks instead.
 */
export function renderDocx(base64: string, data: Record<string, string>): Uint8Array {
  const bytes = base64ToUint8Array(base64);
  const zip = new PizZip(bytes);

  // Separate single-value and multi-value (";") entries
  const renderData: Record<string, string> = {};
  const multi: Record<string, string[]> = {};

  for (const [ph, val] of Object.entries(data)) {
    if (val.includes(";")) {
      const parts = val.split(";").map((v) => v.trim()).filter(Boolean);
      if (parts.length > 1) {
        multi[ph] = parts;
        renderData[ph] = sentinelFor(ph); // replaced after context detection
        continue;
      }
    }
    renderData[ph] = val;
  }

  const doc = new Docxtemplater(zip, {
    delimiters: { start: "{", end: "}" },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => "",
  });
  doc.render(renderData);

  if (!Object.keys(multi).length) {
    return doc.getZip().generate({ type: "uint8array" });
  }

  // Post-process rendered output: expand sentinels based on document context
  const rZip = doc.getZip();
  const xmlParts = [
    "word/document.xml",
    "word/header1.xml", "word/header2.xml",
    "word/footer1.xml", "word/footer2.xml",
  ];

  for (const partName of xmlParts) {
    const raw = rZip.file(partName)?.asText();
    if (!raw) continue;
    if (!Object.keys(multi).some((ph) => raw.includes(sentinelFor(ph)))) continue;

    const xmlDoc = new DOMParser().parseFromString(raw, "application/xml");
    for (const [ph, values] of Object.entries(multi)) {
      expandSentinel(xmlDoc, sentinelFor(ph), values);
    }
    rZip.file(partName, new XMLSerializer().serializeToString(xmlDoc));
  }

  return rZip.generate({ type: "uint8array" });
}

function expandSentinel(xmlDoc: Document, sentinel: string, values: string[]): void {
  // Snapshot to avoid live-NodeList issues during DOM mutation
  const tEls = Array.from(xmlDoc.getElementsByTagNameNS(W, "t"))
    .filter((t) => (t.textContent ?? "").includes(sentinel));

  for (const tEl of tEls) {
    // Walk up to find nearest w:tr or w:p ancestor
    let tr: Element | null = null;
    let p: Element | null = null;
    let cur: Element | null = tEl.parentElement;
    while (cur && cur !== xmlDoc.documentElement) {
      if (cur.localName === "tr") { tr = cur; break; }
      if (cur.localName === "p" && !p) p = cur;
      cur = cur.parentElement;
    }

    const isList = !!p && p.getElementsByTagNameNS(W, "numPr").length > 0;
    const container = tr ?? (isList ? p : null);

    if (container) {
      const parent = container.parentElement;
      if (!parent) continue;
      // Clone the row/paragraph once per value, then remove the original
      for (const val of values) {
        const clone = container.cloneNode(true) as Element;
        for (const ct of Array.from(clone.getElementsByTagNameNS(W, "t"))) {
          if ((ct.textContent ?? "").includes(sentinel)) {
            ct.textContent = (ct.textContent ?? "").split(sentinel).join(val);
          }
        }
        parent.insertBefore(clone, container);
      }
      parent.removeChild(container);
    } else {
      // Regular paragraph: put first value in place, remaining as line-break runs
      let run: Element | null = tEl.parentElement;
      while (run && run.localName !== "r") run = run.parentElement;
      if (!run) {
        tEl.textContent = (tEl.textContent ?? "").split(sentinel).join(values.join(", "));
        continue;
      }

      tEl.textContent = (tEl.textContent ?? "").split(sentinel).join(values[0]);

      let insertAfter: Element = run;
      for (const val of values.slice(1)) {
        const brRun = xmlDoc.createElementNS(W, "w:r");
        brRun.appendChild(xmlDoc.createElementNS(W, "w:br"));
        insertAfter.parentNode!.insertBefore(brRun, insertAfter.nextSibling);

        const textRun = xmlDoc.createElementNS(W, "w:r");
        const rPr = run.getElementsByTagNameNS(W, "rPr")[0];
        if (rPr) textRun.appendChild(rPr.cloneNode(true));
        const newT = xmlDoc.createElementNS(W, "w:t");
        newT.setAttribute("xml:space", "preserve");
        newT.textContent = val;
        textRun.appendChild(newT);
        brRun.parentNode!.insertBefore(textRun, brRun.nextSibling);
        insertAfter = textRun;
      }
    }
  }
}
