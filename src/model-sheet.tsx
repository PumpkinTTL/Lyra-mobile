import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import type { ModelSettings } from "./agent";
import { colors } from "./theme";

type Props = {
  initial: ModelSettings | null;
  onClose: () => void;
  onSave: (settings: ModelSettings | null) => Promise<void>;
};

export function ModelSheet({ initial, onClose, onSave }: Props) {
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [key, setKey] = useState(initial?.apiKey ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(useDemo: boolean) {
    setError("");
    if (saving) return;
    let settings: ModelSettings | null = null;
    if (!useDemo) {
      let url: URL;
      try {
        url = new URL(endpoint.trim());
        if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
          throw new Error();
        }
      } catch {
        setError("请输入有效的 HTTPS API 基础地址，例如 https://api.openai.com/v1。");
        return;
      }
      if (!model.trim() || !key.trim()) {
        setError("请填写模型 ID 和 API Key。");
        return;
      }
      settings = { endpoint: url.toString().replace(/\/+$/, ""), model: model.trim(), apiKey: key.trim() };
    }
    setSaving(true);
    try {
      await onSave(settings);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal animationType="slide" onRequestClose={saving ? undefined : onClose} statusBarTranslucent>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.safe}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <View style={styles.header}>
              <Text style={styles.title}>模型连接</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="关闭" disabled={saving} onPress={onClose} style={styles.icon}>
                <X color={colors.text} size={22} />
              </Pressable>
            </View>
            <Text style={styles.description}>填写支持 OpenAI Chat Completions 的服务。API Key 保存在手机的凭据存储中。</Text>
            <Text style={styles.label}>API 基础地址</Text>
            <TextInput style={styles.input} accessibilityLabel="API 基础地址" placeholder="https://api.openai.com/v1" placeholderTextColor={colors.secondary} value={endpoint} onChangeText={setEndpoint} autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!saving} />
            <Text style={styles.label}>模型 ID</Text>
            <TextInput style={styles.input} accessibilityLabel="模型 ID" placeholder="输入服务提供的模型 ID" placeholderTextColor={colors.secondary} value={model} onChangeText={setModel} autoCapitalize="none" autoCorrect={false} editable={!saving} />
            <Text style={styles.label}>API Key</Text>
            <TextInput style={styles.input} accessibilityLabel="API Key" placeholder="输入你的 Key" placeholderTextColor={colors.secondary} value={key} onChangeText={setKey} autoCapitalize="none" autoCorrect={false} editable={!saving} secureTextEntry />
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            <Pressable accessibilityRole="button" disabled={saving} onPress={() => { void save(false); }} style={styles.save}>
              {saving ? <ActivityIndicator color={colors.accentInk} /> : <Text style={styles.saveText}>保存连接</Text>}
            </Pressable>
            {initial ? (
              <Pressable accessibilityRole="button" disabled={saving} onPress={() => { void save(true); }} style={styles.demo}>
                <Text style={styles.demoText}>移除连接，返回体验模式</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, alignSelf: "center", width: "100%", maxWidth: 560 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title: { fontSize: 25, fontWeight: "600", color: colors.text },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  description: { color: colors.secondary, fontSize: 15, lineHeight: 23, marginBottom: 20 },
  label: { fontSize: 14, color: colors.text, fontWeight: "600", marginBottom: 8 },
  input: { backgroundColor: colors.surface, color: colors.text, paddingHorizontal: 14, minHeight: 50, borderRadius: 12, borderWidth: 1, borderColor: colors.border, marginBottom: 16 },
  save: { backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", minHeight: 48, borderRadius: 12, marginTop: 8 },
  saveText: { color: colors.accentInk, fontSize: 15, fontWeight: "700" },
  demo: { alignItems: "center", justifyContent: "center", minHeight: 48, marginTop: 8 },
  demoText: { color: colors.secondary },
  error: { color: colors.error, marginBottom: 8 },
});
