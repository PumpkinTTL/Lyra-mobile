import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowLeft, Check, ChevronDown, ChevronRight, ChevronUp, Download, ExternalLink, Folder, FolderOpen, Plus, Share2, Upload, X } from "lucide-react-native";
import { unzipSync } from "fflate";
import { SafeAreaView } from "react-native-safe-area-context";
import { bytesFromBase64, createProject, decodeFile, exportProject, importProject, listProjects, openFile, pdfPage, projectIO, saveFile, shareFile, type FileEntry, type Project } from "./device-workspace";
import { officeKind, readOffice } from "./office";
import { safeModelError } from "./model-catalog";
import { colors } from "./theme";
import { FileIcon } from "./file-icon";
import { FileViewer, PageBar, SpreadsheetViewer, TextViewer, mediaContent, officeContent } from "./file-viewer";

type Props = {
  current: string;
  currentName?: string;
  initialPath?: string;
  allowProjectChange: boolean;
  onSelect(project: Project): Promise<void>;
  onClose(): void;
};

type Preview = {
  path: string;
  text?: string;
  content?: ReturnType<typeof mediaContent>;
  spreadsheet?: { source: Uint8Array; sheets: string[] };
  pdf?: { page: number; count: number };
};

const previewLimit = 16 * 1024 * 1024;

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const megabytes = bytes >= 1024 * 1024;
  const value = bytes / (megabytes ? 1024 * 1024 : 1024);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${megabytes ? "MB" : "KB"}`;
}

function validateOfficePreview(bytes: Uint8Array, mainPart: string) {
  let total = 0;
  let count = 0;
  let found = false;
  unzipSync(bytes, { filter: ({ name, originalSize }) => {
    total += originalSize;
    if (++count > 4096 || total > 80 * 1024 * 1024 || originalSize > 32 * 1024 * 1024) {
      throw new Error("文件展开后过大，请用上方操作打开原文件。");
    }
    found ||= name === mainPart;
    return false;
  } });
  if (!found) throw new Error("文件格式不完整，请检查原文件。");
}

async function inspectFile(project: string, path: string, page = 0): Promise<Preview> {
  if (/\.pdf$/i.test(path)) {
    const result = await pdfPage(project, path, page);
    return result ? { path, content: mediaContent("image/png", result.base64), pdf: { page, count: result.count } }
      : { path, text: "应用内无法显示此 PDF，可以用上方操作打开原文件。" };
  }
  const kind = officeKind(path);
  const file = await projectIO(project).read(path, previewLimit);
  if (kind || /^image\/(png|jpeg|gif|webp)$/.test(file.mime)) {
    if (file.truncated) return { path, text: "文件大于 16 MB，可以用上方操作打开或保存原文件。" };
    if (!kind) return { path, content: mediaContent(file.mime, file.base64) };
    const source = bytesFromBase64(file.base64);
    if (kind === "xlsx") {
      const sheets = readOffice(kind, source, 128, { titlesOnly: true }).map(({ title }) => title);
      return { path, spreadsheet: { source, sheets } };
    }
    validateOfficePreview(source, kind === "docx" ? "word/document.xml" : "ppt/presentation.xml");
    return { path, content: officeContent(kind, file.base64) };
  }
  try {
    const content = decodeFile(file.base64);
    return { path, text: content.slice(0, 30_000) + (file.truncated || content.length > 30_000 ? "\n…预览已截断" : "") };
  } catch {
    return { path, text: "可用上方操作打开、分享或另存此文件。" };
  }
}

export function WorkspaceSheet({ current, currentName, initialPath, allowProjectChange, onSelect, onClose }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [folder, setFolder] = useState(initialPath?.split("/").slice(0, -1).join("/") ?? "");
  const [preview, setPreview] = useState<Preview | undefined>(initialPath ? { path: initialPath } : undefined);
  const [focusedPath, setFocusedPath] = useState(initialPath);
  const [showProjects, setShowProjects] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    setBusy(true);
    setError("");
    setNotice("");
    Promise.all([listProjects(), projectIO(current).list(folder, false, 400)]).then(([items, listing]) => {
      if (mounted) {
        setProjects(items);
        setFiles(listing.entries);
        if (listing.truncated) setNotice("目录超过 400 项，可让 Agent 使用 find 查找。");
      }
    }).catch((cause) => { if (mounted) setError(safeModelError(cause)); })
      .finally(() => { if (mounted) setBusy(false); });
    return () => { mounted = false; };
  }, [current, folder]);

  useEffect(() => {
    if (!initialPath) return;
    let active = true;
    inspectFile(current, initialPath).then((file) => {
      if (active) setPreview((visible) => visible?.path === initialPath ? file : visible);
    }).catch((cause) => {
      if (active) setPreview((visible) => visible?.path === initialPath ? { path: initialPath, text: safeModelError(cause) } : visible);
    });
    return () => { active = false; };
  }, [current, initialPath]);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); } catch (cause) { setError(safeModelError(cause)); }
    finally { setBusy(false); }
  }

  function choose(item: Project) {
    void perform(async () => {
      setFolder("");
      setPreview(undefined);
      await onSelect(item);
      onClose();
    });
  }

  function view(item: FileEntry) {
    if (item.directory) { navigate(item.path); return; }
    setFocusedPath(item.path);
    setPreview({ path: item.path });
    void perform(async () => {
      let file: Preview;
      try { file = await inspectFile(current, item.path); }
      catch (cause) { file = { path: item.path, text: safeModelError(cause) }; }
      setPreview((visible) => visible?.path === file.path ? file : visible);
    });
  }

  function navigate(path: string) {
    setFiles([]);
    setBusy(true);
    setFolder(path);
  }

  function back() {
    if (preview) setPreview(undefined);
    else if (folder) navigate(folder.split("/").slice(0, -1).join("/"));
    else onClose();
  }

  function movePdfPage(path: string, page: number) {
    void perform(async () => {
      const file = await inspectFile(current, path, page);
      setPreview((visible) => visible?.path === path ? file : visible);
    });
  }

  function fileActions(file: Preview) {
    return (
      <View style={styles.fileActions}>
        <Pressable accessibilityRole="button" style={styles.fileAction} disabled={busy} onPress={() => void perform(() => openFile(current, file.path))}>
          <ExternalLink size={16} color={colors.secondary} /><Text style={styles.fileActionLabel}>{Platform.OS === "ios" ? "系统预览" : "用其他应用打开"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.fileAction} disabled={busy} onPress={() => void perform(() => shareFile(current, file.path))}>
          <Share2 size={16} color={colors.secondary} /><Text style={styles.fileActionLabel}>分享</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.fileAction} disabled={busy} onPress={() => void perform(async () => {
          const name = await saveFile(current, file.path);
          if (name) setNotice("已保存「" + name + "」。");
        })}>
          <Download size={16} color={colors.secondary} /><Text style={styles.fileActionLabel}>另存</Text>
        </Pressable>
      </View>
    );
  }

  const project = projects.find((item) => item.id === current);
  const projectLabel = project?.name.trim() || currentName?.trim() || "本机工作区";
  const pdf = preview?.pdf;
  return (
    <Modal animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={back}>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView behavior="padding" style={styles.safe}>
          <View style={styles.header}>
            {preview ? (
              <Pressable accessibilityRole="button" accessibilityLabel="返回文件列表" onPress={back} style={styles.icon}><ArrowLeft size={22} color={colors.text} /></Pressable>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel="关闭工作区" onPress={onClose} style={styles.icon}><X size={22} color={colors.text} /></Pressable>
            )}
            {preview ? <View style={styles.previewTitle}>
              <FileIcon name={preview.path} />
              <Text style={styles.fileTitle} numberOfLines={1}>{preview.path.split("/").at(-1)}</Text>
            </View> : <Text style={styles.title}>工作区</Text>}
            <View style={styles.icon} />
          </View>
          {preview ? (
            <View style={styles.preview}>
              {fileActions(preview)}
              {error ? <Text accessibilityRole="alert" style={[styles.error, styles.previewNotice]}>{error}</Text> : null}
              {notice ? <Text style={[styles.hint, styles.previewNotice]}>{notice}</Text> : null}
              {pdf && pdf.count > 1 ? <PageBar page={pdf.page} count={pdf.count} disabled={busy} onChange={(page) => movePdfPage(preview.path, page)} /> : null}
              {preview.content ? <FileViewer key={preview.path + ":" + (pdf?.page ?? 0)} content={preview.content} />
                : preview.spreadsheet ? <SpreadsheetViewer key={preview.path} {...preview.spreadsheet} />
                : preview.text !== undefined ? <TextViewer text={preview.text} />
                : <ActivityIndicator style={styles.previewNotice} color={colors.secondary} />}
            </View>
          ) : (
            <FlatList key={folder} data={files} keyExtractor={(item) => item.path}
              initialNumToRender={12} windowSize={6} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}
              ListHeaderComponent={<>
                <View style={styles.workspaceBar}>
                  <Pressable accessibilityRole="button" accessibilityLabel={"当前工作区 " + projectLabel}
                    accessibilityState={{ expanded: showProjects }} onPress={() => setShowProjects(!showProjects)}
                    style={({ pressed }) => [styles.workspaceSwitch, pressed && styles.selected]}>
                    <FolderOpen size={20} color={colors.secondary} />
                    <Text numberOfLines={1} style={styles.workspaceName}>{projectLabel}</Text>
                    {showProjects ? <ChevronUp size={15} color={colors.secondary} /> : <ChevronDown size={15} color={colors.secondary} />}
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="导出工作区" disabled={busy || !project}
                    onPress={() => { void perform(async () => { const output = await exportProject(current); if (output) setNotice("已导出「" + output + "」。"); }); }}
                    style={({ pressed }) => [styles.icon, pressed && styles.selected, (busy || !project) && styles.disabled]}>
                    <Upload size={19} color={colors.secondary} />
                  </Pressable>
                </View>
                {showProjects ? (
                  <View style={styles.projects}>
                    {projects.map((item) => {
                      const selected = item.id === current;
                      const label = selected ? projectLabel : item.name.trim() || "未命名工作区";
                      return (
                        <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }}
                          disabled={busy || !allowProjectChange} onPress={() => selected ? setShowProjects(false) : choose({ ...item, name: label })}
                          style={({ pressed }) => [styles.row, (pressed || selected) && styles.selected]}>
                          <Text numberOfLines={1} style={styles.rowText}>{label}</Text>
                          {selected ? <Check size={17} color={colors.text} /> : null}
                        </Pressable>
                      );
                    })}
                    <View style={styles.create}>
                      <TextInput accessibilityLabel="工作区名称" value={name} onChangeText={setName} maxLength={80} editable={allowProjectChange}
                        placeholder="新工作区名称" placeholderTextColor={colors.secondary} style={styles.input} />
                      <Pressable accessibilityRole="button" accessibilityLabel="新建工作区" disabled={busy || !name.trim() || !allowProjectChange}
                        onPress={() => { void perform(async () => { await onSelect(await createProject(name)); onClose(); }); }}
                        style={({ pressed }) => [styles.icon, pressed && styles.selected, (busy || !name.trim() || !allowProjectChange) && styles.disabled]}>
                        <Plus size={19} color={colors.text} />
                      </Pressable>
                    </View>
                    <Pressable accessibilityRole="button" disabled={busy || !allowProjectChange}
                      onPress={() => { void perform(async () => { const item = await importProject(); if (item) { await onSelect(item); onClose(); } }); }}
                      style={({ pressed }) => [styles.importAction, pressed && styles.selected, !allowProjectChange && styles.disabled]}>
                      <Download size={17} color={colors.secondary} /><Text style={styles.actionLabel}>导入文件夹</Text>
                    </Pressable>
                  </View>
                ) : null}
                <View style={styles.breadcrumb}>
                  {folder ? <Pressable accessibilityRole="button" accessibilityLabel="返回上一级目录" onPress={back} style={styles.parent}>
                    <ArrowLeft size={18} color={colors.text} />
                  </Pressable> : null}
                  <Text style={styles.section} numberOfLines={1} ellipsizeMode="middle">{folder ? "文件 / " + folder.replaceAll("/", " / ") : "文件"}</Text>
                </View>
                {error ? <Text accessibilityRole="alert" style={[styles.error, styles.listNote]}>{error}</Text> : null}
                {notice ? <Text style={[styles.hint, styles.listNote]}>{notice}</Text> : null}
              </>}
              ListEmptyComponent={busy ? <ActivityIndicator style={styles.listNote} color={colors.secondary} /> : <Text style={[styles.hint, styles.listNote]}>目录为空。</Text>}
              renderItem={({ item }) => (
                <Pressable accessibilityRole="button" onPress={() => view(item)} disabled={busy}
                  style={({ pressed }) => [styles.row, (pressed || focusedPath === item.path) && styles.selected]}>
                  {item.directory ? <Folder size={18} color="#946b29" /> : <FileIcon name={item.path} />}
                  <Text style={styles.rowText} numberOfLines={1}>{item.path.split("/").at(-1)}</Text>
                  {item.directory ? <ChevronRight size={15} color={colors.secondary} /> : <Text style={styles.size}>{fileSize(item.size)}</Text>}
                </Pressable>
              )} />
          )}

        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, minHeight: 56, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "600", textAlign: "center" },
  content: { width: "100%", maxWidth: 680, alignSelf: "center", paddingHorizontal: 18, paddingTop: 12, paddingBottom: 20 },
  workspaceBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  workspaceSwitch: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 10, borderRadius: 10 },
  workspaceName: { color: colors.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  projects: { backgroundColor: colors.raised, padding: 8, borderRadius: 12, gap: 3 },
  section: { color: colors.secondary, fontWeight: "500", fontSize: 13, flexShrink: 1 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 48, borderRadius: 8, gap: 11, paddingHorizontal: 10 },
  selected: { backgroundColor: colors.tint },
  rowText: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15 },
  input: { flex: 1, backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 11, borderWidth: 1, color: colors.text, minHeight: 45, paddingHorizontal: 10 },
  create: { flexDirection: "row", gap: 8 },
  importAction: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 10, borderRadius: 8 },
  actionLabel: { color: colors.text, fontSize: 14 },
  breadcrumb: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 44, marginTop: 7, paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  parent: { width: 34, height: 44, justifyContent: "center" },
  size: { color: colors.secondary, fontSize: 12, fontVariant: ["tabular-nums"] },
  disabled: { opacity: 0.4 },
  listNote: { paddingVertical: 12, paddingHorizontal: 10 },
  hint: { color: colors.secondary, fontSize: 13 },
  error: { color: colors.error, fontSize: 14 },
  preview: { flex: 1 },
  previewTitle: { flex: 1, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 7 },
  fileTitle: { color: colors.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  fileActions: { flexDirection: "row", justifyContent: "center", alignItems: "center", flexWrap: "wrap", paddingHorizontal: 4 },
  fileAction: { flexDirection: "row", minHeight: 44, alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 10 },
  fileActionLabel: { color: colors.text, fontSize: 13 },
  previewNotice: { padding: 12 },
});
