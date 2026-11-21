import { NativeModules } from "react-native";

export const defaultProject = "default";
export type Project = { id: string; name: string };
export type FileEntry = { path: string; directory: boolean; size: number };
export type WorkspaceFile = { base64: string; mime: string; truncated: boolean };
export type WorkspaceAttachment = { name: string; path: string; mime: string; size: number };
export type WorkspaceArtifact = { path: string; projectId?: string };

export type WorkspaceIO = {
  list(path: string, recursive: boolean, limit: number): Promise<{ entries: FileEntry[]; truncated: boolean }>;
  read(path: string, limit: number): Promise<WorkspaceFile>;
  write(path: string, base64: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
};

type NativeWorkspace = {
  loadTranscript(id: string): Promise<string | null>;
  saveTranscript(id: string, json: string): Promise<void>;
  removeTranscript(id: string): Promise<void>;
  listProjects(): Promise<Project[]>;
  createProject(name: string): Promise<Project>;
  importProject(): Promise<Project | null>;
  exportProject(project: string): Promise<string | null>;
  pickAttachments(project: string): Promise<WorkspaceAttachment[] | null>;
  shareFile(project: string, path: string): Promise<void>;
  saveFile(project: string, path: string): Promise<string | null>;
  openFile(project: string, path: string): Promise<void>;
  copyText(text: string): Promise<void>;
  pdfPage?(project: string, path: string, page: number): Promise<{ base64: string; count: number }>;
  list(project: string, path: string, recursive: boolean, limit: number): ReturnType<WorkspaceIO["list"]>;
  read(project: string, path: string, limit: number): ReturnType<WorkspaceIO["read"]>;
  write(project: string, path: string, base64: string): Promise<void>;
  mkdir(project: string, path: string): Promise<void>;
  remove(project: string, path: string): Promise<void>;
};

export function workspaceSupported() {
  return NativeModules.LyraWorkspace != null;
}

function nativeWorkspace(): NativeWorkspace {
  const native = NativeModules.LyraWorkspace as NativeWorkspace | undefined;
  if (!native) throw new Error("此安装包没有工作区模块。");
  return native;
}

export function projectIO(id: string): WorkspaceIO {
  return {
    list: (path, recursive, limit) => nativeWorkspace().list(id, path, recursive, limit),
    read: (path, limit) => nativeWorkspace().read(id, path, limit),
    write: (path, base64) => nativeWorkspace().write(id, path, base64),
    mkdir: (path) => nativeWorkspace().mkdir(id, path),
    remove: (path) => nativeWorkspace().remove(id, path),
  };
}

export const loadTranscript = (id: string) => nativeWorkspace().loadTranscript(id);
export const saveTranscript = (id: string, json: string) => nativeWorkspace().saveTranscript(id, json);
export const deleteTranscript = (id: string) => nativeWorkspace().removeTranscript(id);

export const listProjects = () => nativeWorkspace().listProjects();
export const createProject = (name: string) => nativeWorkspace().createProject(name);
export const importProject = () => nativeWorkspace().importProject();
export const exportProject = (id: string) => nativeWorkspace().exportProject(id);
export const pickAttachments = (id: string) => nativeWorkspace().pickAttachments(id);
export const shareFile = (id: string, path: string) => nativeWorkspace().shareFile(id, relativePath(path));
export const saveFile = (id: string, path: string) => nativeWorkspace().saveFile(id, relativePath(path));
export const openFile = (id: string, path: string) => nativeWorkspace().openFile(id, relativePath(path));
export const copyText = (text: string) => nativeWorkspace().copyText(text);
export const pdfPage = (id: string, path: string, page: number) => nativeWorkspace().pdfPage?.(id, relativePath(path), page);

export function relativePath(value = "."): string {
  const path = value === "/workspace" ? "" : value.replace(/^\/workspace\//, "");
  if (path.startsWith("/") || /[\\\0]/.test(path) || path.split("/").includes("..")) {
    throw new Error("路径必须位于当前工作区。");
  }
  return path.split("/").filter((part) => part && part !== ".").join("/");
}

export function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < bytes.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function decodeFile(base64: string): string {
  const text = new TextDecoder("utf-8").decode(bytesFromBase64(base64));
  if (text.includes("\u0000") || text.includes("\uFFFD")) throw new Error("文件不是可读的 UTF-8 文本。");
  return text;
}

export function encodeFile(text: string): string {
  return base64FromBytes(new TextEncoder().encode(text));
}
