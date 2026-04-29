import type { PageKind } from "@/shared/types";

export function classifyUrl(urlStr: string): PageKind {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { kind: "other" };
  }

  if (url.hostname === "siman.kemenkeu.go.id") return { kind: "siman" };
  if (url.hostname !== "satu.kemenkeu.go.id") return { kind: "other" };

  const path = url.pathname.replace(/\/+$/, "");
  const tab = url.searchParams.get("tab") ?? "";

  if (path === "/nadine/mejaku") {
    const known = ["amplop", "disposisi", "konsep"] as const;
    const norm = (known as readonly string[]).includes(tab)
      ? (tab as (typeof known)[number])
      : "unknown";
    return { kind: "inbox", tab: norm };
  }

  if (path.startsWith("/nadine/preview") || /\/nadine\/.*(detail|view|baca|preview)/.test(path)) {
    const ndIdQuery = url.searchParams.get("ndId") ?? url.searchParams.get("id");
    return { kind: "detail", ndId: ndIdQuery && /^\d+$/.test(ndIdQuery) ? ndIdQuery : "" };
  }

  const ndIdQuery = url.searchParams.get("ndId") ?? url.searchParams.get("id");
  if (ndIdQuery && /^\d+$/.test(ndIdQuery)) return { kind: "detail", ndId: ndIdQuery };

  if (/^\/nadine\/.*\/(buat|baru|new|create)/.test(path)) return { kind: "create" };
  if (path === "/beranda" || path === "") return { kind: "beranda" };

  return { kind: "other" };
}

export function isSimanPage(urlStr: string): boolean {
  try { return new URL(urlStr).hostname === "siman.kemenkeu.go.id"; }
  catch { return false; }
}
