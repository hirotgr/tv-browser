import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      main: "src/main/main.ts",
      "renderer-preload": "src/main/renderer-preload.ts"
    },
    outDir: "dist/main",
    platform: "node",
    target: "node20",
    format: ["cjs"],
    external: ["electron"],
    sourcemap: true,
    splitting: false,
    clean: true
  },
  {
    entry: {
      app: "src/renderer/app.ts"
    },
    outDir: "dist/renderer",
    platform: "browser",
    target: "es2020",
    format: ["esm"],
    sourcemap: true,
    splitting: false,
    clean: false
  }
]);
