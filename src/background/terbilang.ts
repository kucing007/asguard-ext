const SATUAN = ["", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan",
  "sepuluh", "sebelas", "dua belas", "tiga belas", "empat belas", "lima belas", "enam belas",
  "tujuh belas", "delapan belas", "sembilan belas"];
const PULUHAN = ["", "", "dua puluh", "tiga puluh", "empat puluh", "lima puluh",
  "enam puluh", "tujuh puluh", "delapan puluh", "sembilan puluh"];

function terbilangRatusan(n: number): string {
  if (n === 0) return "";
  if (n < 20) return SATUAN[n];
  if (n < 100) {
    const r = n % 10;
    return PULUHAN[Math.floor(n / 10)] + (r ? " " + SATUAN[r] : "");
  }
  const r = n % 100;
  const ratus = Math.floor(n / 100);
  const prefix = ratus === 1 ? "seratus" : SATUAN[ratus] + " ratus";
  return prefix + (r ? " " + terbilangRatusan(r) : "");
}

export function terbilang(amount: number): string {
  if (amount === 0) return "nol";
  const parts: string[] = [];
  const units = [
    { value: 1_000_000_000_000, name: "triliun" },
    { value: 1_000_000_000, name: "miliar" },
    { value: 1_000_000, name: "juta" },
    { value: 1_000, name: "ribu" },
    { value: 1, name: "" },
  ];
  let remaining = Math.floor(Math.abs(amount));
  for (const { value, name } of units) {
    const chunk = Math.floor(remaining / value);
    if (chunk > 0) {
      const words = chunk === 1 && value === 1000
        ? "seribu"
        : terbilangRatusan(chunk) + (name ? " " + name : "");
      parts.push(words.trim());
      remaining -= chunk * value;
    }
  }
  return parts.join(" ").trim();
}

export function terbilangRupiah(amount: number): string {
  return terbilang(amount) + " rupiah";
}
