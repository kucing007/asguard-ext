import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "Asguard — Nadine AI",
  short_name: "Asguard",
  description: pkg.description,
  version: pkg.version,
  // Pinning the public key fixes the extension ID across installs (unpacked OR
  // .crx) so chrome.storage.local survives when users unzip a new release into
  // a different folder. Derived from dist.pem — DO NOT change without losing
  // every existing user's templates/settings/tokens.
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAryGGequdwP9y5pdF/qowm7awUs6cg1LN2Sq4h2TvKnHbqYgxmzDFqggtRjr1bXdVfrcZ02O7fp6kS+klPw9dv5osIAQhtQmOMRY+PNNU6E2Zl8YcFKaCX4qJcXDK+XEzAzH8NjyMi+gvz0r2V3OWEz2seqkv21OIyl6vdBqsQX20L+cZFLICDpqlbJl9J3bYrXJm4xNWg6EL69vfooWT1/WbzFu4F3MlLYy8PePxul/b/U2s9ezspgOXa3CYBxPGth/7RUx5Vz17T7mCCo0Xzviuy4LAmdjZNyf5vN5tP7qAJuAmrgmcDX++5OvXXD6JV0IEaOV7Cf+mFWrP3bzlSQIDAQAB",
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
