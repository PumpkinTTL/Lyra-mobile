import { renderAsync } from "docx-preview";
import { inflateSync } from "fflate";
import PptxRenderer from "pptx-browser";

const [format, data] = window.lyraPreviewInput;
const reader = document.getElementById("reader");
const post = (state) => window.ReactNativeWebView?.postMessage(JSON.stringify(state));

function bytes(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function supportDeflate() {
  const native = window.DecompressionStream;
  try { new native("deflate-raw"); return; } catch { /* Older WebViews accept gzip only. */ }
  window.DecompressionStream = class {
    constructor(type) {
      if (type !== "deflate-raw") return new native(type);
      const chunks = [];
      const stream = new TransformStream({
        transform(chunk) { chunks.push(chunk); },
        flush(controller) {
          const merged = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
          let offset = 0;
          for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
          controller.enqueue(inflateSync(merged));
        },
      });
      this.readable = stream.readable;
      this.writable = stream.writable;
    }
  };
}

function fitDocument() {
  for (const page of reader.querySelectorAll("section.document-page")) {
    page.style.zoom = "1";
    const width = page.getBoundingClientRect().width;
    if (width) page.style.zoom = String(Math.min(1, reader.clientWidth / width));
  }
}

async function open() {
  const source = bytes(data);
  window.lyraPreviewInput = undefined;
  if (format === "docx") {
    await renderAsync(source, reader, undefined, { className: "document-page", useBase64URL: true, renderAltChunks: false,
      renderComments: false, breakPages: true });
    fitDocument();
    window.addEventListener("resize", fitDocument);
    post({ type: "ready" });
    return;
  }

  supportDeflate();
  const deck = new PptxRenderer();
  await deck.load(source);
  if (!deck.slideCount) throw new Error("演示文稿没有可预览的幻灯片。");
  let version = 0;
  window.lyraShowSlide = async (index) => {
    const generation = ++version;
    try {
      const canvas = document.createElement("canvas");
      canvas.setAttribute("aria-label", `第 ${index + 1} 张幻灯片`);
      await deck.renderSlide(index, canvas, 1440);
      if (generation !== version) return;
      reader.replaceChildren(canvas);
      post({ type: "slide", index, count: deck.slideCount });
    } catch {
      if (generation === version) post({ type: "failed" });
    }
  };
  window.addEventListener("pagehide", () => deck.destroy(), { once: true });
  await window.lyraShowSlide(0);
}

document.addEventListener("click", (event) => { if (event.target?.closest?.("a")) event.preventDefault(); });
open().catch(() => post({ type: "failed" }));
