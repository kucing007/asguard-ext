import PizZip from "pizzip";

const PLACEHOLDER_RE = /\{([^}{]+)\}/g;

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function stripXmlTags(xml: string): string {
  return xml.replace(/<[^>]+>/g, "");
}

/** Extract unique {placeholder} names from a docx file (base64-encoded). */
export function scanPlaceholders(base64: string): string[] {
  try {
    const bytes = base64ToUint8Array(base64);
    const zip = new PizZip(bytes);

    // Collect text from the main document + headers/footers
    const parts = [
      "word/document.xml",
      "word/header1.xml",
      "word/header2.xml",
      "word/footer1.xml",
      "word/footer2.xml",
    ];

    const allText = parts
      .map((p) => {
        try {
          return zip.file(p)?.asText() ?? "";
        } catch {
          return "";
        }
      })
      .join("");

    const plain = stripXmlTags(allText);
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(plain)) !== null) {
      const name = m[1].trim();
      if (name) found.add(name);
    }
    return [...found].sort();
  } catch {
    return [];
  }
}
