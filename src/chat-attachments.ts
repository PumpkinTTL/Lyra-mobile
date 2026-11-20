import { localUserMessage, type LocalUserMessage } from "./agent";
import { decodeFile, projectIO, type WorkspaceAttachment } from "./device-workspace";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

const images = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const previewLimit = 42_000;
const mediaLimit = 3 * 1024 * 1024;

export async function prepareUserMessage(project: string, text: string, attachments: readonly WorkspaceAttachment[]): Promise<LocalUserMessage> {
  const content: (TextContent | ImageContent)[] = [{
    type: "text", text: text || "请查看这些附件。",
  }];
  const io = projectIO(project);
  for (const attachment of attachments) {
    const { name, path, mime, size } = attachment;
    content.push({ type: "text", text: "附件：" + name + "，工作区路径：" + path + "（" + mime + "，" + size + " 字节）。" });
    if (images.has(mime) && size <= mediaLimit) {
      const file = await io.read(path, mediaLimit);
      if (!file.truncated) content.push({ type: "image", mimeType: mime, data: file.base64 });
    } else if (size <= previewLimit && (mime.startsWith("text/") || /\.(json|ya?ml|toml|tsx?|[cm]?jsx?|py|rs|go|java|kt|sh|css|html?|xml|csv|log|mdx?)$/i.test(name))) {
      const file = await io.read(path, previewLimit);
      let value: string | undefined;
      try { value = decodeFile(file.base64); } catch { /* Non-text files remain accessible by their workspace path. */ }
      if (value !== undefined && !file.truncated) content.push({ type: "text", text: "附件「" + name + "」的文本：\n" + value });
    }
  }
  return localUserMessage(text, content, attachments.map(({ name, path, mime }) => ({ name, path, mime })));
}
