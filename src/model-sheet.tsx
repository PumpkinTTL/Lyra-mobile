import { useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ArrowLeft, Check, ChevronRight, Cpu, Plus, Server, Trash2, X } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type ModelRef, type Provider, protocols, providerRef, safeModelError, sameModel } from "./model-catalog";
import { ProviderEditor } from "./provider-editor";
import { colors } from "./theme";

type Props = {
  initialPage: "settings" | "models";
  providers: Provider[];
  current: ModelRef;
  onClose: () => void;
  onSelect: (model: ModelRef) => Promise<void>;
  onSave: (provider: Provider, selected: ModelRef) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

type Page = "settings" | "models" | "edit";

export function ModelSheet({ initialPage, providers, current, onClose, onSelect, onSave, onDelete }: Props) {
  const [page, setPage] = useState<Page>(initialPage);
  const [backPage, setBackPage] = useState<"settings" | "models">(initialPage);
  const [editing, setEditing] = useState<Provider>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const currentProvider = providers.find((provider) => provider.id === current?.providerId);
  const activeLabel = current
    ? currentProvider?.models.includes(current.model) ? current.model : "模型不可用"
    : "体验模式";

  function edit(provider?: Provider) {
    setError("");
    setEditing(provider);
    setBackPage(page === "models" ? "models" : "settings");
    setPage("edit");
  }

  function close() {
    if (busy) return;
    if (page === "edit") setPage(backPage);
    else if (page === "models" && initialPage === "settings") setPage("settings");
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

  function modelRow(label: string, subtitle: string | undefined, model: ModelRef) {
    const selected = sameModel(current, model);
    return (
      <Pressable key={model?.model ?? "demo"} accessibilityRole="radio" accessibilityState={{ checked: selected, disabled: busy }}
        disabled={busy} onPress={() => { void apply(() => onSelect(model), onClose); }}
        style={[styles.row, selected && styles.selected]}>
        <View style={styles.details}>
          <Text style={styles.name} numberOfLines={1}>{label}</Text>
          {subtitle ? <Text style={styles.caption}>{subtitle}</Text> : null}
        </View>
        {selected ? <Check color={colors.accent} size={20} /> : null}
      </Pressable>
    );
  }

  const title = page === "models" ? "选择模型" : page === "edit" ? editing ? "编辑供应商" : "添加供应商" : "设置";
  const back = page === "edit" || (page === "models" && initialPage === "settings");

  return (
    <Modal animationType="slide" onRequestClose={close}>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.safe}>
          <View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel={back ? "返回" : "关闭设置"} onPress={close} disabled={busy} style={styles.icon}>
              {back ? <ArrowLeft color={colors.text} size={22} /> : <X color={colors.text} size={22} />}
            </Pressable>
            <Text style={styles.heading}>{title}</Text>
            {page === "edit" && editing ? (
              <Pressable accessibilityRole="button" accessibilityLabel="移除供应商" disabled={busy} onPress={() => askDelete(editing)} style={styles.icon}>
                <Trash2 color={colors.error} size={19} />
              </Pressable>
            ) : <View style={styles.icon} />}
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            {page === "edit" ? (
              <ProviderEditor key={editing?.id ?? "new"} provider={editing} onSave={onSave} onBusy={setBusy}
                onSaved={(activated) => { if (activated) onClose(); else setPage("settings"); }} />
            ) : null}
            {page === "settings" ? (
              <>
                <Pressable accessibilityRole="button" onPress={() => setPage("models")} style={styles.row}>
                  <Cpu size={20} color={colors.accent} />
                  <View style={styles.details}>
                    <Text style={styles.caption}>当前对话模型</Text>
                    <Text style={styles.name} numberOfLines={1}>{activeLabel}</Text>
                  </View>
                  <ChevronRight size={18} color={colors.secondary} />
                </Pressable>
                <Text style={styles.section}>模型供应商</Text>
                {providers.map((provider) => (
                  <Pressable key={provider.id} accessibilityRole="button" accessibilityLabel={"编辑供应商 " + provider.name}
                    onPress={() => edit(provider)} style={styles.row}>
                    <Server size={20} color={colors.accent} />
                    <View style={styles.details}>
                      <Text style={styles.name} numberOfLines={1}>{provider.name}</Text>
                      <Text style={styles.caption}>{protocols[provider.protocol].label} · {provider.models.length} 个模型</Text>
                      <Text style={styles.caption} numberOfLines={1}>{provider.endpoint}</Text>
                    </View>
                    <ChevronRight size={18} color={colors.secondary} />
                  </Pressable>
                ))}
                <Pressable accessibilityRole="button" onPress={() => edit()} style={styles.add}>
                  <Plus size={19} color={colors.accentInk} />
                  <Text style={styles.addLabel}>添加供应商</Text>
                </Pressable>
              </>
            ) : null}
            {page === "models" ? (
              <>
                {modelRow("体验模式", "在手机上运行本地示例", null)}
                {providers.map((provider) => (
                  <View key={provider.id} style={styles.group}>
                    <Text style={styles.section}>{provider.name}</Text>
                    {provider.models.map((model) => modelRow(model, undefined, providerRef(provider, model)))}
                    {!provider.models.length ? (
                      <Pressable accessibilityRole="button" onPress={() => edit(provider)} style={styles.row}>
                        <Plus color={colors.accent} size={18} /><Text style={styles.name}>添加模型</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ))}
                <Pressable accessibilityRole="button" disabled={busy} onPress={() => edit()} style={styles.add}>
                  <Plus size={19} color={colors.accentInk} />
                  <Text style={styles.addLabel}>添加供应商</Text>
                </Pressable>
              </>
            ) : null}
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: 12, backgroundColor: colors.surface, minHeight: 56 },
  heading: { color: colors.text, fontSize: 19, fontWeight: "700" },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  content: { padding: 18, paddingBottom: 32, alignSelf: "center", width: "100%", maxWidth: 600, gap: 10 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 52, gap: 12, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  selected: { backgroundColor: colors.tint, borderColor: colors.tintBorder },
  details: { flex: 1, gap: 3 },
  name: { color: colors.text, fontSize: 15, fontWeight: "600" },
  caption: { color: colors.secondary, fontSize: 13, lineHeight: 18 },
  section: { color: colors.text, fontSize: 16, fontWeight: "700", marginTop: 10, marginBottom: 2 },
  group: { gap: 7 },
  add: { flexDirection: "row", minHeight: 48, borderRadius: 13, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", gap: 8, marginTop: 7 },
  addLabel: { color: colors.accentInk, fontSize: 15, fontWeight: "700" },
  error: { color: colors.error, fontSize: 14, lineHeight: 21 },
});
