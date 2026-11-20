import { build } from "esbuild";

await build({
  entryPoints: ["scripts/pi-entry.mjs"],
  outfile: "src/pi-runtime.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2017",
  minify: true,
  legalComments: "eof",
});
