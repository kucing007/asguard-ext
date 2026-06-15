/**
 * Terbilang — Convert a number to Indonesian words.
 * e.g. 1400 → "seribu empat ratus"
 *      21500 → "dua puluh satu ribu lima ratus"
 */

const SATUAN = ["", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan"];

function terbilangInner(n: number): string {
  if (n < 0) return `minus ${terbilangInner(-n)}`;
  if (n === 0) return "";
  if (n < 10) return SATUAN[n];
  if (n === 10) return "sepuluh";
  if (n === 11) return "sebelas";
  if (n < 20) return `${SATUAN[n - 10]} belas`;
  if (n < 100) {
    const puluhan = Math.floor(n / 10);
    const sisa = n % 10;
    return sisa === 0 ? `${SATUAN[puluhan]} puluh` : `${SATUAN[puluhan]} puluh ${SATUAN[sisa]}`;
  }
  if (n < 200) {
    const sisa = n - 100;
    return sisa === 0 ? "seratus" : `seratus ${terbilangInner(sisa)}`;
  }
  if (n < 1000) {
    const ratusan = Math.floor(n / 100);
    const sisa = n % 100;
    return sisa === 0 ? `${SATUAN[ratusan]} ratus` : `${SATUAN[ratusan]} ratus ${terbilangInner(sisa)}`;
  }
  if (n < 2000) {
    const sisa = n - 1000;
    return sisa === 0 ? "seribu" : `seribu ${terbilangInner(sisa)}`;
  }
  if (n < 1_000_000) {
    const ribuan = Math.floor(n / 1000);
    const sisa = n % 1000;
    return sisa === 0 ? `${terbilangInner(ribuan)} ribu` : `${terbilangInner(ribuan)} ribu ${terbilangInner(sisa)}`;
  }
  if (n < 1_000_000_000) {
    const jutaan = Math.floor(n / 1_000_000);
    const sisa = n % 1_000_000;
    return sisa === 0 ? `${terbilangInner(jutaan)} juta` : `${terbilangInner(jutaan)} juta ${terbilangInner(sisa)}`;
  }
  if (n < 1_000_000_000_000) {
    const miliaran = Math.floor(n / 1_000_000_000);
    const sisa = n % 1_000_000_000;
    return sisa === 0 ? `${terbilangInner(miliaran)} miliar` : `${terbilangInner(miliaran)} miliar ${terbilangInner(sisa)}`;
  }
  const triliunan = Math.floor(n / 1_000_000_000_000);
  const sisa = n % 1_000_000_000_000;
  return sisa === 0 ? `${terbilangInner(triliunan)} triliun` : `${terbilangInner(triliunan)} triliun ${terbilangInner(sisa)}`;
}

/**
 * Convert a number to Indonesian words (terbilang / pembilang).
 * Returns the words with each word lowercase.
 *
 * Examples:
 *   terbilang(0) → "nol"
 *   terbilang(11) → "sebelas"
 *   terbilang(1400) → "seribu empat ratus"
 *   terbilang(21500) → "dua puluh satu ribu lima ratus"
 *   terbilang(1_250_000) → "satu juta dua ratus lima puluh ribu"
 */
export function terbilang(n: number): string {
  if (!Number.isFinite(n)) return "";
  const num = Math.floor(Math.abs(n));
  if (num === 0) return "nol";
  const result = terbilangInner(num).trim();
  return n < 0 ? `minus ${result}` : result;
}
