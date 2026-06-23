import {
  bodyTables,
  cellText,
  cloneAndAppendRow,
  getTableHeader,
  removeRow,
  rowCells,
  setCellText,
  tableColumns,
  tableRows,
} from "./docx-xml";

export interface LogicalTable {
  header: string[];
  cols: number;
  dataRows: string[][];
}

/** Value-equality key for a header tuple (Python compares tuples). */
function headerKey(h: string[]): string {
  return JSON.stringify(h);
}

/** Merge PDF-fragmented tables in a section into logical tables. (merge_section_tables) */
export function mergeSectionTables(doc: Document, tableIndices: number[]): LogicalTable[] {
  const tables = bodyTables(doc);
  const logical: LogicalTable[] = [];
  for (const tidx of tableIndices) {
    const table = tables[tidx];
    if (!table) continue;
    const header = getTableHeader(table);
    const cols = tableColumns(table);
    const rows = tableRows(table);
    const dataRows: string[][] = [];
    for (let i = 0; i < rows.length; i++) {
      if (i === 0) continue; // header row
      dataRows.push(rowCells(rows[i]).map((tc) => cellText(tc).trim()));
    }
    if (logical.length) {
      const prev = logical[logical.length - 1];
      if (headerKey(prev.header) === headerKey(header) && prev.cols === cols) {
        if (dataRows.length && header.length && header[0] === "No") {
          const firstNo = (dataRows[0]?.[0] ?? "").trim();
          if (/^-?\d+$/.test(firstNo) && parseInt(firstNo, 10) !== 1) {
            prev.dataRows.push(...dataRows);
            continue;
          }
        }
      }
    }
    logical.push({ header, cols, dataRows });
  }
  return logical;
}

/** Fill a table with dataRows, adjusting row count. Header preserved. (fill_table) */
export function fillTable(tbl: Element, dataRows: string[][]): void {
  const original = tableRows(tbl).length - 1;
  const needed = dataRows.length;
  for (let i = 0; i < needed; i++) {
    const rowData = dataRows[i];
    const tr = i < original ? tableRows(tbl)[i + 1] : cloneAndAppendRow(tbl);
    const cells = rowCells(tr);
    for (let j = 0; j < rowData.length; j++) {
      if (j < cells.length) setCellText(cells[j], rowData[j]);
    }
  }
  if (needed < original) {
    for (let k = 0; k < original - needed; k++) {
      const r = tableRows(tbl);
      removeRow(tbl, r.length - 1);
    }
  }
}

interface TmplTableInfo {
  table: Element;
  header: string[];
  cols: number;
  originalDataRows: number;
}

/**
 * Distribute datasource logical-table data across template tables.
 * Handles 1:1, 1:many (identical header), and many:many (grouped) cases.
 * (distribute_data_to_tables)
 */
export function distributeDataToTables(
  doc: Document,
  tmplIndices: number[],
  logicalTables: LogicalTable[],
): number {
  if (!tmplIndices.length || !logicalTables.length) return 0;
  let filled = 0;
  const tables = bodyTables(doc);
  const tmplTables: TmplTableInfo[] = tmplIndices.map((tidx) => {
    const t = tables[tidx];
    return {
      table: t,
      header: getTableHeader(t),
      cols: tableColumns(t),
      originalDataRows: tableRows(t).length - 1,
    };
  });

  // Case 1: same count → straight 1:1 fill.
  if (logicalTables.length === tmplTables.length) {
    for (let i = 0; i < tmplTables.length; i++) {
      fillTable(tmplTables[i].table, logicalTables[i].dataRows);
      filled += 1;
    }
    return filled;
  }

  // Case 2: 1 logical, many template tables with identical header → proportional split.
  if (logicalTables.length === 1) {
    const lt = logicalTables[0];
    const headers = new Set(tmplTables.map((tt) => headerKey(tt.header)));
    if (headers.size === 1) {
      const allRows = lt.dataRows;
      const total = allRows.length;
      const totalCap = tmplTables.reduce((s, tt) => s + tt.originalDataRows, 0);
      let offset = 0;
      for (let i = 0; i < tmplTables.length; i++) {
        const tt = tmplTables[i];
        let chunk: string[][];
        if (i === tmplTables.length - 1) {
          chunk = allRows.slice(offset);
        } else {
          const prop = totalCap > 0 ? tt.originalDataRows / totalCap : 1.0 / tmplTables.length;
          const chunkSize = Math.round(total * prop);
          chunk = allRows.slice(offset, offset + chunkSize);
          offset += chunkSize;
        }
        if (chunk.length) {
          fillTable(tt.table, chunk);
          filled += 1;
        }
      }
      return filled;
    }
  }

  // Case 3: group template tables by consecutive identical header+cols, match each
  // group to the next logical table (proportional split within multi-table groups).
  const tmplGroups: TmplTableInfo[][] = [];
  let currentGroup: TmplTableInfo[] = [tmplTables[0]];
  for (let i = 1; i < tmplTables.length; i++) {
    const tt = tmplTables[i];
    const last = currentGroup[currentGroup.length - 1];
    if (headerKey(last.header) === headerKey(tt.header) && last.cols === tt.cols) {
      currentGroup.push(tt);
    } else {
      tmplGroups.push(currentGroup);
      currentGroup = [tt];
    }
  }
  tmplGroups.push(currentGroup);

  let ltIdx = 0;
  for (const group of tmplGroups) {
    if (ltIdx >= logicalTables.length) break;
    const lt = logicalTables[ltIdx];
    const groupHeader = group[0].header;
    if (headerKey(lt.header) === headerKey(groupHeader) || lt.cols === group[0].cols) {
      if (group.length === 1) {
        fillTable(group[0].table, lt.dataRows);
        filled += 1;
      } else {
        const allRows = lt.dataRows;
        const total = allRows.length;
        const totalCap = group.reduce((s, tt) => s + tt.originalDataRows, 0);
        let offset = 0;
        for (let i = 0; i < group.length; i++) {
          const tt = group[i];
          let chunk: string[][];
          if (i === group.length - 1) {
            chunk = allRows.slice(offset);
          } else {
            const prop = totalCap > 0 ? tt.originalDataRows / totalCap : 1.0 / group.length;
            const sz = Math.round(total * prop);
            chunk = allRows.slice(offset, offset + sz);
            offset += sz;
          }
          if (chunk.length) {
            fillTable(tt.table, chunk);
            filled += 1;
          }
        }
      }
      ltIdx += 1;
    } else {
      ltIdx += 1;
    }
  }
  return filled;
}
