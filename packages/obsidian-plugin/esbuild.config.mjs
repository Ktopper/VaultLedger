import esbuild from "esbuild";
import { existsSync } from "node:fs";
// Phase 4 creates src/main.ts. Until then, fall back to the stub entry so this
// config is valid; the real bundle is produced once src/main.ts exists.
const entry = existsSync("src/main.ts") ? "src/main.ts" : "src/index.ts";
await esbuild.build({
  entryPoints: [entry],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["obsidian", "electron"],
  sourcemap: true,
  logLevel: "info",
});
