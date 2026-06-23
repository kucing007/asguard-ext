import { bodyEl, flowParaText } from "./docx-xml";

export type FlowEntry =
  | { type: "para"; text: string }
  | { type: "table"; index: number };

export interface Section {
  text: string | null;
  tables: number[];
}

export interface SectionMatch {
  template: Section;
  datasource: Section | null;
}

/** Ordered flow of body paragraphs (non-empty) and table indices. (get_document_flow) */
export function getDocumentFlow(doc: Document): FlowEntry[] {
  const flow: FlowEntry[] = [];
  let tidx = 0;
  for (const el of Array.from(bodyEl(doc).childNodes)) {
    if (el.nodeType !== 1) continue;
    const tag = (el as Element).localName ?? "";
    if (tag === "p") {
      const text = flowParaText(el as Element);
      if (text) flow.push({ type: "para", text });
    } else if (tag === "tbl") {
      flow.push({ type: "table", index: tidx });
      tidx += 1;
    }
  }
  return flow;
}

/** Group flow into sections: (joined paragraph text, table indices). (build_sections) */
export function buildSections(flow: FlowEntry[]): Section[] {
  const sections: Section[] = [];
  let currentParas: string[] = [];
  let currentTables: number[] = [];
  for (const entry of flow) {
    if (entry.type === "para") {
      if (currentTables.length) {
        const text = currentParas.length ? currentParas.join(" | ") : null;
        sections.push({ text, tables: currentTables });
        currentTables = [];
        currentParas = [entry.text];
      } else {
        currentParas.push(entry.text);
      }
    } else {
      currentTables.push(entry.index);
    }
  }
  if (currentTables.length) {
    const text = currentParas.length ? currentParas.join(" | ") : null;
    sections.push({ text, tables: currentTables });
  }
  return sections;
}

/** Word-overlap similarity * 100. (_text_sim) */
export function textSim(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const wa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common += 1;
  return (common / Math.max(wa.size, wb.size)) * 100;
}

/**
 * Match template sections to datasource sections by text similarity. Accepts a
 * best unused datasource section only if score > 25; else leaves unmatched.
 * (match_sections_by_para)
 */
export function matchSectionsByPara(tmpl: Section[], ds: Section[]): SectionMatch[] {
  const matches: SectionMatch[] = [];
  const dsUsed = new Set<number>();
  for (const tSection of tmpl) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let j = 0; j < ds.length; j++) {
      if (dsUsed.has(j)) continue;
      const score = textSim(tSection.text, ds[j].text);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0 && bestScore > 25) {
      matches.push({ template: tSection, datasource: ds[bestIdx] });
      dsUsed.add(bestIdx);
    } else {
      matches.push({ template: tSection, datasource: null });
    }
  }
  return matches;
}
