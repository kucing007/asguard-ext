import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest.config";
import obfuscatorPlugin from "rollup-plugin-obfuscator";

export default defineConfig(({ mode }) => ({
  plugins: [
    preact(),
    crx({ manifest }),
  ],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  build: {
    target: "es2022",
    minify: true,
    sourcemap: false,
    rollupOptions: {
      plugins: mode === "production" ? [
        obfuscatorPlugin({
          options: {
            compact: true,
            controlFlowFlattening: false,
            deadCodeInjection: false,
            debugProtection: false,
            selfDefending: false,
            stringArray: true,
            stringArrayEncoding: ["base64"],
            stringArrayThreshold: 1.0,
            identifierNamesGenerator: "hexadecimal",
            splitStrings: false,
            renameGlobals: false,
            rotateStringArray: true,
            shuffleStringArray: true,
          },
        }),
      ] : [],
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5174 },
  },
}));
