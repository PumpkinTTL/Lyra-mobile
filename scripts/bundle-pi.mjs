import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const mobileCredentials = {
  name: "mobile-pi-credentials",
  setup(plugin) {
    plugin.onLoad({ filter: /[\\/]pi-ai[\\/]dist[\\/]env-api-keys\.js$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      const nodeRuntime = 'typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)';
      if (!source.includes(nodeRuntime)) throw new Error("Pi's environment credential check changed. Verify the mobile bundle.");
      return { contents: source.replaceAll(nodeRuntime, "false"), loader: "js" };
    });
  },
};

await build({
  entryPoints: ["scripts/pi-entry.mjs"],
  outfile: "src/pi-runtime.js",
  bundle: true,
  platform: "browser",
  alias: { "node:zlib": "./scripts/mobile-zlib.mjs" },
  format: "esm",
  target: "es2017",
  minify: true,
  legalComments: "eof",
  plugins: [mobileCredentials],
});
