/**
 * Format a raw input value according to its PlaceholderConfig type.
 * Used by both ManualInputView and MailMergeView to format values before docx rendering.
 */

import type { PlaceholderConfig, PlaceholderType } from "@/shared/types";
import { terbilang } from "./terbilang";

const BULAN = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

/**
 * Format a date string (ISO or yyyy-mm-dd) into the specified format.
 *
 * Supported formats:
 *   "DD MMMM YYYY"  → "15 Juni 2026"
 *   "DD-MM-YYYY"    → "15-06-2026"
 *   "DD/MM/YYYY"    → "15/06/2026"
 *   "YYYY-MM-DD"    → "2026-06-15"
 */
function formatDate(isoDate: string, format: string): string {
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return isoDate; // fallback

  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  const mmmm = BULAN[d.getMonth()];

  switch (format) {
    case "DD-MM-YYYY": return `${dd}-${mm}-${yyyy}`;
    case "DD/MM/YYYY": return `${dd}/${mm}/${yyyy}`;
    case "YYYY-MM-DD": return `${yyyy}-${mm}-${dd}`;
    case "DD MMMM YYYY":
    default:
      return `${parseInt(dd)} ${mmmm} ${yyyy}`;
  }
}

/**
 * Format a number as Indonesian currency string.
 * e.g. 1250000 → "Rp1.250.000"
 */
function formatCurrency(val: number): string {
  const abs = Math.abs(Math.floor(val));
  const formatted = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return val < 0 ? `-Rp${formatted}` : `Rp${formatted}`;
}

/**
 * Format a raw string value based on placeholder type configuration.
 */
export function formatPlaceholderValue(rawValue: string, type: PlaceholderType, dateFormat?: string): string {
  if (!rawValue.trim()) return "";

  switch (type) {
    case "text":
      return rawValue;

    case "number": {
      const num = parseFloat(rawValue);
      if (isNaN(num)) return rawValue;
      return Number.isInteger(num) ? String(num) : String(num);
    }

    case "date":
      return formatDate(rawValue, dateFormat ?? "DD MMMM YYYY");

    case "currency": {
      const num = parseFloat(rawValue);
      if (isNaN(num)) return rawValue;
      return formatCurrency(num);
    }

    case "terbilang": {
      const num = parseFloat(rawValue);
      if (isNaN(num)) return rawValue;
      return terbilang(num);
    }

    default:
      return rawValue;
  }
}

/**
 * Get the configuration for a placeholder by name, falling back to a text type.
 */
export function getConfigForPlaceholder(
  name: string,
  configs?: PlaceholderConfig[],
): PlaceholderConfig {
  const found = configs?.find((c) => c.name === name);
  return found ?? { name, type: "text" };
}

/** Human-readable label for a PlaceholderType */
export function placeholderTypeLabel(type: PlaceholderType): string {
  switch (type) {
    case "text": return "Teks";
    case "number": return "Angka";
    case "date": return "Tanggal";
    case "currency": return "Mata Uang (Rp)";
    case "terbilang": return "Terbilang";
    default: return "Teks";
  }
}

/** Available date format options */
export const DATE_FORMATS = [
  { value: "DD MMMM YYYY", label: "15 Juni 2026" },
  { value: "DD-MM-YYYY", label: "15-06-2026" },
  { value: "DD/MM/YYYY", label: "15/06/2026" },
  { value: "YYYY-MM-DD", label: "2026-06-15" },
];
