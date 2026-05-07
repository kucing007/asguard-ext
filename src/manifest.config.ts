import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "Asguard — Nadine AI",
  short_name: "Asguard",
  description: pkg.description,
  version: pkg.version,
  icons: {
    16: "src/icons/icon-16.png",
    32: "src/icons/icon-32.png",
    48: "src/icons/icon-48.png",
    128: "src/icons/icon-128.png",
  },
  action: {
    default_title: "Asguard — buka panel",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: [
        "https://satu.kemenkeu.go.id/*",
        "https://service.kemenkeu.go.id/*",
        "https://siman.kemenkeu.go.id/*",
      ],
      js: ["src/content/page-inject.ts"],
      run_at: "document_start",
      all_frames: false,
      world: "MAIN",
    },
    {
      matches: [
        "https://satu.kemenkeu.go.id/*",
        "https://service.kemenkeu.go.id/*",
        "https://siman.kemenkeu.go.id/*",
      ],
      js: ["src/content/index.ts"],
      run_at: "document_start",
      all_frames: false,
    },
  ],
  permissions: ["storage", "sidePanel", "scripting", "activeTab", "tabs", "alarms", "downloads", "notifications"],
  host_permissions: [
    "https://satu.kemenkeu.go.id/*",
    "https://service.kemenkeu.go.id/*",
    "https://satu-notif.kemenkeu.go.id/*",
    "https://satu-file.kemenkeu.go.id/*",
    "https://siman.kemenkeu.go.id/*",
    "https://siman-svc.kemenkeu.go.id/*",
    "http://localhost:8080/*",
    "http://127.0.0.1:8080/*",
    "https://vps.asetpattimura.my.id/*",
  ],
});
