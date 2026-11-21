import { localUserMessage, type LocalUserMessage } from "./agent";
import { bytesFromBase64, decodeFile, projectIO, type WorkspaceAttachment } from "./device-workspace";
import { officeKind, readOffice } from "./office";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

const images = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const previewLimit = 42_000;
const mediaLimit = 3 * 1024 * 1024;

export async function prepareUserMessage(project: string, text: string, attachments: readonly WorkspaceAttachment[], signal?: AbortSignal, supportsImages = true): Promise<LocalUserMessage> {
  const content: (TextContent | ImageContent)[] = [{
    type: "text", text: text || "请查看这些附件。",
  }];
  const io = projectIO(project);
  let officePreviewBudget = 8000;
  for (const attachment of attachments) {
    if (signal?.aborted) throw new Error("附件准备已取消。");
    const { name, path, mime, size } = attachment;
    content.push({ type: "text", text: "附件：" + name + "，工作区路径：" + path + "（" + mime + "，" + size + " 字节）。" });
    const kind = officeKind(path);
    if (kind) {
      content.push({ type: "text", text: `用 office_inspect 和 path=${path} 分段读取这份 Office 附件。预览只是文件开头。` });
      if (officePreviewBudget > 0 && size <= 2 * 1024 * 1024) {
        try {
          const file = await io.read(path, 2 * 1024 * 1024);
          const preview = !file.truncated && readOffice(kind, bytesFromBase64(file.base64), 3, { limit: 12, columns: 12 })
            .flatMap(({ title, lines }) => [title, ...lines]).join("\n").slice(0, Math.min(3000, officePreviewBudget));
          if (preview) {
            officePreviewBudget -= preview.length;
            content.push({ type: "text", text: `附件「${name}」的内容预览：\n${preview}` });
          }
        } catch { /* Preview failure leaves the original attachment available to the tools. */ }
      }
    } else if (supportsImages && images.has(mime) && size <= mediaLimit) {
      const file = await io.read(path, mediaLimit);
      if (!file.truncated) content.push({ type: "image", mimeType: mime, data: file.base64 });
    } else if (size <= previewLimit && (mime.startsWith("text/") || /\.(json|ya?ml|toml|tsx?|[cm]?jsx?|py|rs|go|java|kt|sh|css|html?|xml|csv|log|mdx?)$/i.test(name))) {
      const file = await io.read(path, previewLimit);
      let value: string | undefined;
      try { value = decodeFile(file.base64); } catch { /* Non-text files remain accessible by their workspace path. */ }
      if (value !== undefined && !file.truncated) content.push({ type: "text", text: "附件「" + name + "」的文本：\n" + value });
    }
  }
  return localUserMessage(text, content, attachments.map(({ name, path, mime }) => ({ name, path, mime, projectId: project })));
}
