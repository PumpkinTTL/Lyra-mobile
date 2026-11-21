import { useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowLeft, Brain, Check, ChevronRight, Cpu, FolderOpen, Plus, Search, Server, Terminal, Trash2, X } from "lucide-react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRef, type Provider, effectiveThinking, modelOptions, protocols, providerRef, reasoningChoices, safeModelError, sameModel, thinkingLabels } from "./model-catalog";
import { ProviderEditor } from "./provider-editor";
import { colors } from "./theme";

type Props = {
  initialPage: "settings" | "models";
  providers: Provider[];
  current: ModelRef;
  thinking: ThinkingLevel;
  projectName: string;
  running: boolean;
  onClose: () => void;
  onSelect: (model: ModelRef) => Promise<void>;
  onThinking: (thinking: ThinkingLevel) => Promise<void>;
  onWorkspace: () => void;
  onSsh: () => void;
  onSave: (provider: Provider, selected: ModelRef) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

type Page = "settings" | "models" | "thinking" | "edit";

export function ModelSheet({ initialPage, providers, current, thinking, projectName, running, onClose, onSelect, onThinking, onWorkspace, onSsh, onSave, onDelete }: Props) {
  const { bottom } = useSafeAreaInsets();
  const [page, setPage] = useState<Page>(initialPage);
  const [backPage, setBackPage] = useState<"settings" | "models">(initialPage);
  const [editing, setEditing] = useState<Provider>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const currentProvider = providers.find((provider) => provider.id === current?.providerId);
  const options = currentProvider && current ? modelOptions(currentProvider, current.model) : undefined;
  const choices = reasoningChoices(options);
  const activeThinking = effectiveThinking(options, thinking);
  const thinkLabel = options?.reasoning === false ? "不支持" : thinkingLabels[activeThinking === "off" || choices.length ? activeThinking : "on"];
  const activeLabel = current
    ? currentProvider?.models.includes(current.model) ? current.model : "模型不可用"
    : "未选择模型";

  function edit(provider?: Provider) {
    setError("");
    setEditing(provider);
    setBackPage(page === "models" ? "models" : "settings");
    setPage("edit");
  }

  function close() {
    if (busy) return;
    if (page === "edit") setPage(backPage);
    else if (page === "thinking" || (page === "models" && initialPage === "settings")) {
      setError("");
      setQuery("");
      setPage("settings");
    }
    else onClose();
  }

  async function apply(action: () => Promise<void>, next: () => void) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      next();
    } catch (cause) {
      setError(safeModelError(cause));
    } finally {
      setBusy(false);
    }
  }

  function askDelete(provider: Provider) {
    Alert.alert("移除供应商？", "会删除此供应商的连接和 Key。已有对话会保留，可以为它们重新选择模型。", [
      { text: "取消", style: "cancel" },
      { text: "移除", style: "destructive", onPress: () => { void apply(() => onDelete(provider.id), () => setPage("settings")); } },
    ]);
  }

  function modelRow(label: string, model: ModelRef) {
    const selected = sameModel(current, model);
    return (
      <Pressable key={model?.model ?? "none"} accessibilityRole="radio" accessibilityState={{ checked: selected, disabled: busy }}
        disabled={busy} onPress={() => { void apply(() => onSelect(model), onClose); }}
        style={({ pressed }) => [styles.option, (selected || pressed) && styles.selected]}>
        <Text style={styles.optionLabel} numberOfLines={1}>{label}</Text>
        {selected ? <Check color={colors.text} size={17} /> : null}
      </Pressable>
    );
  }

  const title = page === "models" ? "选择模型" : page === "thinking" ? "思考级别" : page === "edit" ? editing ? "编辑供应商" : "添加供应商" : "设置";
  const back = page === "edit" || page === "thinking" || (page === "models" && initialPage === "settings");
  const floating = page === "models" && initialPage === "models";
  const keyword = query.trim().toLowerCase();
  const groups = providers.map((provider) => ({
    provider, models: !keyword || provider.name.toLowerCase().includes(keyword)
      ? provider.models : provider.models.filter((model) => model.toLowerCase().includes(keyword)),
  })).filter(({ models }) => !keyword || models.length);

  return (
    <Modal animationType="slide" transparent={floating} statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
      <SafeAreaView edges={floating ? ["top", "left", "right"] : undefined} style={[styles.safe, floating && styles.backdrop]}>
        <KeyboardAvoidingView behavior="padding" style={[styles.safe, floating && styles.sheetPosition]}>
          {floating ? <Pressable accessibilityElementsHidden importantForAccessibility="no" onPress={close} style={StyleSheet.absoluteFill} /> : null}
          <View style={floating ? [styles.sheet, { paddingBottom: bottom }] : styles.safe}>
            <View style={styles.header}>
              <Pressable accessibilityRole="button" accessibilityLabel={back ? "返回" : page === "models" ? "关闭模型选择" : "关闭设置"} onPress={close} disabled={busy} style={styles.icon}>
                {back ? <ArrowLeft color={colors.text} size={22} /> : <X color={colors.text} size={22} />}
              </Pressable>
              <Text style={styles.heading}>{title}</Text>
              {page === "edit" && editing ? (
                <Pressable accessibilityRole="button" accessibilityLabel="移除供应商" disabled={busy} onPress={() => askDelete(editing)} style={styles.icon}>
                  <Trash2 color={colors.error} size={19} />
                </Pressable>
              ) : <View style={styles.icon} />}
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" style={floating && styles.sheetScroll} contentContainerStyle={[styles.content, floating && styles.sheetContent]}>
              {page === "edit" ? (
                <ProviderEditor key={editing?.id ?? "new"} provider={editing} onSave={onSave} onBusy={setBusy}
                  onSaved={(activated) => { if (activated) onClose(); else setPage("settings"); }} />
              ) : null}
              {page === "settings" ? (
                <>
                  <Text style={styles.section}>当前对话</Text>
                  <View style={styles.settingsGroup}>
                    {([
                      [Cpu, "当前对话模型", activeLabel, () => setPage("models")],
                      [Brain, "思考级别", thinkLabel, () => setPage("thinking")],
                      [FolderOpen, "工作区", projectName, onWorkspace],
                      [Terminal, "SSH 连接", "管理", onSsh],
                    ] as const).map(([Icon, label, value, onPress]) => (
                      <Pressable key={label} accessibilityRole="button" accessibilityLabel={label + "：" + value}
                        onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.selected]}>
                        <Icon size={18} color={colors.secondary} />
                        <Text style={styles.name}>{label}</Text>
                        <Text style={styles.settingValue} numberOfLines={1}>{value}</Text>
                        <ChevronRight size={16} color={colors.secondary} />
                      </Pressable>
                    ))}
                  </View>
                  <Text style={styles.section}>模型供应商</Text>
                  {providers.map((provider) => (
                    <Pressable key={provider.id} accessibilityRole="button" accessibilityLabel={"编辑供应商 " + provider.name}
                      onPress={() => edit(provider)} style={({ pressed }) => [styles.row, styles.providerRow, pressed && styles.selected]}>
                      <Server size={18} color={colors.secondary} />
                      <View style={styles.details}>
                        <Text style={styles.name} numberOfLines={1}>{provider.name}</Text>
                        <Text style={styles.caption}>{protocols[provider.protocol].label} · {provider.models.length} 个模型</Text>
                      </View>
                      <ChevronRight size={16} color={colors.secondary} />
                    </Pressable>
                  ))}
                  <Pressable accessibilityRole="button" onPress={() => edit()} style={styles.add}>
                    <Plus size={17} color={colors.text} />
                    <Text style={styles.addLabel}>添加供应商</Text>
                  </Pressable>
                </>
              ) : null}
              {page === "models" ? (
                <>
                  {running ? <Text style={styles.caption}>模型调整从下一轮生效。</Text> : null}
                  {providers.some((provider) => provider.models.length > 0) ? (
                    <View style={styles.search}>
                      <Search size={16} color={colors.secondary} />
                      <TextInput accessibilityLabel="搜索模型" placeholder="搜索模型" placeholderTextColor={colors.secondary} value={query}
                        autoCorrect={false} autoCapitalize="none" onChangeText={setQuery} style={styles.searchInput} />
                    </View>
                  ) : null}
                  {!keyword ? modelRow("未选择模型", null) : null}
                  {groups.map(({ provider, models }) => (
                    <View key={provider.id} style={styles.group}>
                      <Text style={styles.groupLabel}>{provider.name}</Text>
                      {models.map((model) => modelRow(model, providerRef(provider, model)))}
                      {!provider.models.length ? (
                        <Pressable accessibilityRole="button" onPress={() => edit(provider)} style={styles.row}>
                          <Plus color={colors.accent} size={18} /><Text style={styles.name}>添加模型</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ))}
                  {keyword && !groups.length ? <Text style={styles.caption}>没有找到匹配的模型。</Text> : null}
                  {!keyword ? (
                    <Pressable accessibilityRole="button" disabled={busy} onPress={() => edit()} style={styles.option}>
                      <Plus size={17} color={colors.text} />
                      <Text style={styles.optionLabel}>添加供应商</Text>
                    </Pressable>
                  ) : null}
                </>
              ) : null}
              {page === "thinking" ? (
                <>
                  <Text style={styles.caption}>{options?.reasoning === false ? "当前模型标记为不支持思考。" : running ? "思考档位调整从下一轮生效。" : "此设置用于当前对话。"}</Text>
                  {(options?.reasoning === false ? ["off"] as const : ["off", ...(choices.length ? choices : ["low"] as const)] as const).map((level) => (
                    <Pressable key={level} accessibilityRole="radio" accessibilityState={{ checked: activeThinking === level, disabled: busy }}
                      disabled={busy} onPress={() => { void apply(() => onThinking(level), () => setPage("settings")); }}
                      style={({ pressed }) => [styles.option, (activeThinking === level || pressed) && styles.selected]}>
                      <Text style={styles.optionLabel}>{thinkingLabels[level === "off" || choices.length ? level : "on"]}</Text>
                      {activeThinking === level ? <Check size={17} color={colors.text} /> : null}
                    </Pressable>
                  ))}
                </>
              ) : null}
              {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  backdrop: { backgroundColor: colors.overlay },
  sheetPosition: { backgroundColor: "transparent", justifyContent: "flex-end" },
  sheet: { alignSelf: "center", width: "100%", maxWidth: 600, maxHeight: "82%", borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden", backgroundColor: colors.surface },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingHorizontal: 12, backgroundColor: colors.background, minHeight: 56 },
  heading: { color: colors.text, fontSize: 16, fontWeight: "600" },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  content: { padding: 18, paddingBottom: 32, alignSelf: "center", width: "100%", maxWidth: 600, gap: 10 },
  sheetContent: { paddingTop: 12, paddingBottom: 12, gap: 4 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 47, gap: 10, paddingHorizontal: 10, borderRadius: 8 },
  settingsGroup: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingBottom: 12 },
  settingValue: { flex: 1, textAlign: "right", color: colors.secondary, fontSize: 13 },
  providerRow: { paddingVertical: 6 },
  option: { flexDirection: "row", alignItems: "center", minHeight: 44, gap: 8, paddingHorizontal: 10, borderRadius: 8 },
  optionLabel: { flex: 1, fontSize: 14, color: colors.text },
  selected: { backgroundColor: colors.tint },
  search: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 8 },
  searchInput: { flex: 1, color: colors.text, fontSize: 14, paddingVertical: 7 },
  details: { flex: 1, gap: 3 },
  name: { color: colors.text, fontSize: 15, fontWeight: "500" },
  caption: { color: colors.secondary, fontSize: 13, lineHeight: 18 },
  section: { color: colors.secondary, fontSize: 13, fontWeight: "500", marginTop: 8, paddingHorizontal: 10 },
  group: { gap: 2, paddingVertical: 3 },
  groupLabel: { color: colors.secondary, fontSize: 12, fontWeight: "500", paddingHorizontal: 10, paddingVertical: 6 },
  add: { flexDirection: "row", minHeight: 44, borderRadius: 8, alignItems: "center", gap: 10, paddingHorizontal: 10 },
  addLabel: { color: colors.text, fontSize: 15, fontWeight: "500" },
  error: { color: colors.error, fontSize: 14, lineHeight: 21 },
});
