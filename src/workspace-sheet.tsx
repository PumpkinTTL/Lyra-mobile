import { useEffect, useState } from "react";
import { ActivityIndicator, Image, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Download, ExternalLink, File, Folder, FolderOpen, Plus, Share2, Upload, X } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { bytesFromBase64, createProject, decodeFile, exportProject, importProject, listProjects, openFile, pdfPage, projectIO, saveFile, shareFile, type FileEntry, type Project } from "./device-workspace";
import { officeKind, readOffice, type OfficeSection } from "./office";
import { safeModelError } from "./model-catalog";
import { colors } from "./theme";

type Props = {
  current: string;
  currentName?: string;
  initialPath?: string;
  allowProjectChange: boolean;
  onSelect(project: Project): Promise<void>;
  onClose(): void;
};

type Preview = { path: string; text?: string; image?: string; office?: OfficeSection[]; pdf?: { page: number; count: number } };

async function inspectFile(project: string, path: string, page = 0): Promise<Preview> {
  if (/\.pdf$/i.test(path)) {
    const result = await pdfPage(project, path, page);
    return result ? { path, image: "data:image/png;base64," + result.base64, pdf: { page, count: result.count } }
      : { path, text: "点击「系统预览」查看 PDF。" };
  }
  const kind = officeKind(path);
  const file = await projectIO(project).read(path, kind ? 16 * 1024 * 1024 : 4 * 1024 * 1024);
  if (kind && !file.truncated) return { path, office: readOffice(kind, bytesFromBase64(file.base64), 60) };
  if (/^image\/(png|jpeg|gif|webp)$/.test(file.mime) && !file.truncated) return { path, image: "data:" + file.mime + ";base64," + file.base64 };
  try {
    const content = decodeFile(file.base64);
    return { path, text: content.slice(0, 30_000) + (file.truncated || content.length > 30_000 ? "\n…预览已截断" : "") };
  } catch {
    return { path, text: "可用系统预览打开此文件，也可分享或另存。" };
  }
}

export function WorkspaceSheet({ current, currentName, initialPath, allowProjectChange, onSelect, onClose }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [folder, setFolder] = useState(initialPath?.split("/").slice(0, -1).join("/") ?? "");
  const [preview, setPreview] = useState<Preview | undefined>(initialPath ? { path: initialPath } : undefined);
  const [section, setSection] = useState(0);
  const [focusedPath, setFocusedPath] = useState(initialPath);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    setBusy(true);
    setError("");
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
    if (item.directory) { setFolder(item.path); return; }
    setFocusedPath(item.path);
    setSection(0);
    setPreview({ path: item.path });
    void perform(async () => {
      let file: Preview;
      try { file = await inspectFile(current, item.path); }
      catch (cause) { file = { path: item.path, text: safeModelError(cause) }; }
      setPreview((visible) => visible?.path === file.path ? file : visible);
    });
  }

  function movePdfPage(path: string, page: number) {
    void perform(async () => {
      const file = await inspectFile(current, path, page);
      setPreview((visible) => visible?.path === path ? file : visible);
    });
  }

  function fileActions(file: Preview) {
    return (
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" style={styles.action} disabled={busy} onPress={() => void perform(() => openFile(current, file.path))}>
          <ExternalLink size={16} color={colors.text} /><Text style={styles.actionLabel}>系统预览</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.action} disabled={busy} onPress={() => void perform(() => shareFile(current, file.path))}>
          <Share2 size={16} color={colors.text} /><Text style={styles.actionLabel}>分享</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.action} disabled={busy} onPress={() => void perform(async () => {
          const name = await saveFile(current, file.path);
          if (name) setNotice("已保存「" + name + "」。");
        })}>
          <Download size={16} color={colors.text} /><Text style={styles.actionLabel}>另存</Text>
        </Pressable>
      </View>
    );
  }

  const project = projects.find((item) => item.id === current);
  const pdf = preview?.pdf;
  return (
    <Modal animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={preview ? () => setPreview(undefined) : onClose}>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView behavior="padding" style={styles.safe}>
          <View style={styles.header}>
            {preview ? (
              <Pressable accessibilityRole="button" accessibilityLabel="返回文件列表" onPress={() => setPreview(undefined)} style={styles.icon}><ArrowLeft size={22} color={colors.text} /></Pressable>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel="关闭工作区" onPress={onClose} style={styles.icon}><X size={22} color={colors.text} /></Pressable>
            )}
            <Text style={styles.title} numberOfLines={1}>{preview?.path ?? "工作区"}</Text>
            <View style={styles.icon} />
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {preview ? (
              <>
                {fileActions(preview)}
                {pdf ? (
                  <View style={styles.pager}>
                    <Pressable accessibilityLabel="上一页" disabled={busy || pdf.page === 0} style={styles.icon}
                      onPress={() => movePdfPage(preview.path, pdf.page - 1)}><ChevronLeft size={19} color={colors.text} /></Pressable>
                    <Text style={styles.hint}>{pdf.page + 1} / {pdf.count}</Text>
                    <Pressable accessibilityLabel="下一页" disabled={busy || pdf.page + 1 >= pdf.count} style={styles.icon}
                      onPress={() => movePdfPage(preview.path, pdf.page + 1)}><ChevronRight size={19} color={colors.text} /></Pressable>
                  </View>
                ) : null}
                {preview.image ? <Image accessibilityLabel="文件预览" source={{ uri: preview.image }} style={styles.image} resizeMode="contain" /> : null}
                {preview.office ? (
                  <>
                    {preview.office.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actions}>
                      {preview.office.map((item, index) => <Pressable key={index} accessibilityRole="button" accessibilityState={{ selected: section === index }}
                        onPress={() => setSection(index)} style={[styles.action, section === index && styles.activeSection]}><Text style={styles.actionLabel}>{item.title}</Text></Pressable>)}
                    </ScrollView> : null}
                    <Text style={styles.hint}>内容预览 · 完整版式可用系统预览打开</Text>
                    {preview.office[section]?.rows ? <ScrollView horizontal><View>
                      {preview.office[section].rows!.map((row, index) => <View key={index} style={styles.tableRow}>
                        {row.map((cell, cellIndex) => <Text key={cellIndex} selectable style={styles.cell}>{cell.slice(0, 250)}</Text>)}
                      </View>)}
                    </View></ScrollView> : <Text selectable style={styles.reading}>{preview.office[section]?.lines.join("\n\n").slice(0, 30_000) || "没有可预览的文本。"}</Text>}
                  </>
                ) : null}
                {preview.text !== undefined ? <Text selectable style={styles.code}>{preview.text || "空文件"}</Text> : null}
                {preview.text === undefined && !preview.image && !preview.office ? <ActivityIndicator color={colors.secondary} /> : null}
              </>
            ) : (
              <>
                <Text style={styles.section}>当前对话工作区</Text>
                {projects.map((item) => {
                  const selected = item.id === current;
                  const label = item.name.trim() || (selected ? currentName?.trim() : undefined) || "未命名工作区";
                  return (
                    <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }}
                      disabled={busy || !allowProjectChange} onPress={() => choose({ ...item, name: label })}
                      style={({ pressed }) => [styles.row, (pressed || selected) && styles.selected]}>
                      <FolderOpen size={18} color={colors.secondary} />
                      <Text numberOfLines={1} style={styles.rowText}>{label}</Text>
                      {selected ? <Check size={17} color={colors.text} /> : null}
                    </Pressable>
                  );
                })}
                <View style={styles.create}>
                  <TextInput accessibilityLabel="工作区名称" value={name} onChangeText={setName} maxLength={80} editable={allowProjectChange}
                    placeholder="新工作区名称" placeholderTextColor={colors.secondary} style={styles.input} />
                  <Pressable accessibilityRole="button" accessibilityLabel="新建工作区" disabled={busy || !name.trim() || !allowProjectChange}
                    onPress={() => { void perform(async () => { await onSelect(await createProject(name)); onClose(); }); }} style={styles.action}>
                    <Plus size={19} color={colors.accent} />
                  </Pressable>
                </View>
                <View style={styles.actions}>
                  <Pressable accessibilityRole="button" disabled={busy || !allowProjectChange} style={styles.action}
                    onPress={() => { void perform(async () => { const item = await importProject(); if (item) { await onSelect(item); onClose(); } }); }}>
                    <Download size={17} color={colors.accent} /><Text style={styles.actionLabel}>导入文件夹</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" disabled={busy || !project} style={styles.action}
                    onPress={() => { void perform(async () => { const output = await exportProject(current); if (output) setNotice("已导出「" + output + "」。"); }); }}>
                    <Upload size={17} color={colors.accent} /><Text style={styles.actionLabel}>导出工作区</Text>
                  </Pressable>
                </View>
                <View style={styles.breadcrumb}>
                  {folder ? <Pressable accessibilityRole="button" accessibilityLabel="返回上一级目录" onPress={() => setFolder(folder.split("/").slice(0, -1).join("/"))}><ArrowLeft size={19} color={colors.accent} /></Pressable> : null}
                  <Text style={styles.section} numberOfLines={1}>{folder || project?.name || "文件"}</Text>
                </View>
                {files.map((item) => (
                  <Pressable key={item.path} accessibilityRole="button" onPress={() => view(item)} disabled={busy} style={[styles.row, focusedPath === item.path && styles.selected]}>
                    {item.directory ? <Folder size={18} color={colors.accent} /> : <File size={17} color={colors.secondary} />}
                    <Text style={styles.rowText} numberOfLines={1}>{item.path.split("/").pop()}</Text>
                    {!item.directory ? <Text style={styles.hint}>{item.size} B</Text> : null}
                  </Pressable>
                ))}
                {!files.length && !busy ? <Text style={styles.hint}>目录为空。</Text> : null}
              </>
            )}
            {busy ? <ActivityIndicator color={colors.accent} /> : null}
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            {notice ? <Text style={styles.hint}>{notice}</Text> : null}
          </ScrollView>
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
  content: { width: "100%", maxWidth: 640, alignSelf: "center", padding: 18, gap: 8 },
  section: { color: colors.secondary, fontWeight: "500", fontSize: 13, marginVertical: 5, flexShrink: 1 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 44, borderRadius: 8, gap: 10, paddingHorizontal: 10 },
  selected: { backgroundColor: colors.tint },
  rowText: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15 },
  input: { flex: 1, backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 11, borderWidth: 1, color: colors.text, minHeight: 45, paddingHorizontal: 10 },
  create: { flexDirection: "row", gap: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  action: { flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", minWidth: 47, minHeight: 44, backgroundColor: colors.tint, borderRadius: 10, paddingHorizontal: 10 },
  actionLabel: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  breadcrumb: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 7 },
  hint: { color: colors.secondary, fontSize: 13 },
  error: { color: colors.error, fontSize: 14 },
  code: { color: colors.text, fontFamily: "monospace", lineHeight: 20, fontSize: 14 },
  reading: { color: colors.text, fontSize: 16, lineHeight: 24, paddingVertical: 12 },
  pager: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 14 },
  tableRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  cell: { width: 124, padding: 8, color: colors.text, borderRightWidth: StyleSheet.hairlineWidth, borderColor: colors.border, fontSize: 13 },
  activeSection: { borderWidth: 1, borderColor: colors.secondary },
  image: { width: "100%", height: 340, backgroundColor: colors.surface },
});
