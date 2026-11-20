import { useEffect, useState } from "react";
import { ActivityIndicator, Image, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowLeft, Check, Download, File, Folder, FolderOpen, Plus, Upload, X } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createProject, decodeFile, exportProject, importProject, listProjects, projectIO, type FileEntry, type Project } from "./device-workspace";
import { safeModelError } from "./model-catalog";
import { colors } from "./theme";

type Props = {
  current: string;
  onSelect(project: Project): Promise<void>;
  onClose(): void;
};

export function WorkspaceSheet({ current, onSelect, onClose }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [folder, setFolder] = useState("");
  const [preview, setPreview] = useState<{ path: string; text?: string; image?: string }>();
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
    void perform(async () => {
      const file = await projectIO(current).read(item.path, 3 * 1024 * 1024);
      if (/^image\/(png|jpeg|gif|webp)$/.test(file.mime) && !file.truncated) {
        setPreview({ path: item.path, image: "data:" + file.mime + ";base64," + file.base64 });
      } else {
        let text: string;
        try {
          const content = decodeFile(file.base64);
          text = content.slice(0, 30_000) + (file.truncated || content.length > 30_000 ? "\n…预览已截断" : "");
        } catch {
          text = "此文件为二进制格式。可以通过导出工作区取回原文件。";
        }
        setPreview({ path: item.path, text });
      }
    });
  }

  const project = projects.find((item) => item.id === current);
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
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
            {preview ? (preview.image
              ? <Image source={{ uri: preview.image }} style={styles.image} resizeMode="contain" />
              : <Text selectable style={styles.code}>{preview.text}</Text>
            ) : (
              <>
                <Text style={styles.section}>当前对话工作区</Text>
                {projects.map((item) => (
                  <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: item.id === current }}
                    disabled={busy} onPress={() => choose(item)} style={[styles.row, item.id === current && styles.selected]}>
                    <FolderOpen size={19} color={colors.accent} /><Text style={styles.rowText}>{item.name}</Text>
                    {item.id === current ? <Check size={20} color={colors.accent} /> : null}
                  </Pressable>
                ))}
                <View style={styles.create}>
                  <TextInput accessibilityLabel="工作区名称" value={name} onChangeText={setName} maxLength={80}
                    placeholder="新工作区名称" placeholderTextColor={colors.secondary} style={styles.input} />
                  <Pressable accessibilityRole="button" accessibilityLabel="新建工作区" disabled={busy || !name.trim()}
                    onPress={() => { void perform(async () => { await onSelect(await createProject(name)); onClose(); }); }} style={styles.action}>
                    <Plus size={19} color={colors.accent} />
                  </Pressable>
                </View>
                <View style={styles.actions}>
                  <Pressable accessibilityRole="button" disabled={busy} style={styles.action}
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
                  <Pressable key={item.path} accessibilityRole="button" onPress={() => view(item)} disabled={busy} style={styles.row}>
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
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, minHeight: 56, backgroundColor: colors.surface, borderBottomWidth: 1, borderColor: colors.border },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: colors.text, fontSize: 19, fontWeight: "700", textAlign: "center" },
  content: { width: "100%", maxWidth: 640, alignSelf: "center", padding: 18, gap: 8 },
  section: { color: colors.text, fontWeight: "700", fontSize: 16, marginVertical: 5, flexShrink: 1 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 45, backgroundColor: colors.surface, borderRadius: 11, borderWidth: 1, borderColor: colors.border, gap: 9, paddingHorizontal: 10 },
  selected: { backgroundColor: colors.tint, borderColor: colors.tintBorder },
  rowText: { flex: 1, color: colors.text, fontSize: 15 },
  input: { flex: 1, backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 11, borderWidth: 1, color: colors.text, minHeight: 45, paddingHorizontal: 10 },
  create: { flexDirection: "row", gap: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  action: { flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", minWidth: 47, minHeight: 44, backgroundColor: colors.tint, borderRadius: 10, paddingHorizontal: 10 },
  actionLabel: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  breadcrumb: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 7 },
  hint: { color: colors.secondary, fontSize: 13 },
  error: { color: colors.error, fontSize: 14 },
  code: { color: colors.text, fontFamily: "monospace", lineHeight: 20, fontSize: 14 },
  image: { width: "100%", height: 340, backgroundColor: colors.surface },
});
