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

const powerpointText = {
  name: "powerpoint-text",
  setup(plugin) {
    plugin.onLoad({ filter: /[\\/]pptx-browser[\\/]src[\\/]render\.js$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      // pptx-browser 4.1.5 skips paragraphs on the early defRPr reference and loses text and bullet colors.
      const declaration = "    const defRPr = g1(pPr, 'defRPr');";
      const use = "    const bullet = pPr ? parseBullet(pPr, defRPr, themeColors, themeData) : null;";
      const fill = "        ctx.fillStyle = c ? colorToCss(c) : '#000000';";
      const bullet = "        drawBullet(ctx, bullet, bulletX, baseline, autoNumCounters);";
      const bulletSize = "ctx.font.match(/(d+(?:.d+)?)px/)";
      const outline = "export function applyOutline(ctx, lnEl, themeColors, scale) {";
      if ([declaration, use, fill, bullet, bulletSize, outline].some((line) => source.split(line).length !== 2)) {
        throw new Error("PowerPoint renderer changed. Verify its paragraph rendering before updating.");
      }
      return { contents: source.replace(declaration, "").replace(use, declaration + "\n" + use)
        .replace(fill, "        ctx.fillStyle = c ?? '#000000';")
        .replace(bullet, "        ctx.fillStyle = runs[0]?.color ?? '#000000';\n        ctx.font = runs[0]?.fontInfo.fontStr ?? ctx.font;\n" + bullet)
        .replace(bulletSize, "ctx.font.match(/(\\d+(?:\\.\\d+)?)px/)")
        .replace(outline, outline + "\n  if (lnEl && !lnEl.hasAttributes() && !lnEl.children.length) return;"), loader: "js" };
    });
  },
};

const { outputFiles: [viewer] } = await build({
  entryPoints: ["scripts/office-viewer.mjs"],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  target: "es2020",
  minify: true,
  legalComments: "eof",
  plugins: [powerpointText],
});

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
  footer: { js: `export const officeViewerScript = ${JSON.stringify(viewer.text)};` },
  plugins: [mobileCredentials],
});
