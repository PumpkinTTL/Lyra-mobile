import { useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { X } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { safeModelError } from "./model-catalog";
import { loadSshProfile, saveSshProfile, testSsh, type SshProfile } from "./ssh";
import { colors } from "./theme";

const initial: SshProfile = { host: "", port: 22, username: "", fingerprint: "", auth: { type: "password", password: "" } };

export function SshSheet({ enabled, onToggle, onClose }: { enabled: boolean; onToggle: (target?: string) => Promise<void>; onClose: () => void }) {
  const [profile, setProfile] = useState(initial);
  const [port, setPort] = useState("22");
  const [active, setActive] = useState(enabled);
  const [task, setTask] = useState<"load" | "save" | "test" | null>("load");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    loadSshProfile().then((saved) => {
      if (live && saved) { setProfile(saved); setPort(String(saved.port)); }
    }).catch((cause) => { if (live) setError(safeModelError(cause)); })
      .finally(() => { if (live) setTask(null); });
    return () => { live = false; };
  }, []);

  async function perform(action: "save" | "test") {
    if (task) return;
    setNotice(""); setError(""); setTask(action);
    try {
      const value = { ...profile, port: Number(port) };
      if (action === "test") { await testSsh(value); setNotice("指纹校验和登录成功。"); }
      else {
        const target = value.host.trim() || active ? await saveSshProfile(value) : undefined;
        await onToggle(active ? target : undefined);
        onClose();
      }
    } catch (cause) { setError(safeModelError(cause)); }
    finally { setTask(null); }
  }

  function field(label: string, value: string, onChangeText: (text: string) => void, secret = false, multiline = false) {
    return <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} editable={!task} value={value} onChangeText={onChangeText} autoCapitalize="none"
        autoCorrect={false} secureTextEntry={secret} multiline={multiline} style={[styles.input, multiline && styles.multiline]} />
    </View>;
  }

  return (
    <Modal animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={task ? undefined : onClose}>
      <SafeAreaView style={styles.screen}>
        <KeyboardAvoidingView behavior="padding" style={styles.screen}>
          <View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭 SSH 设置" disabled={!!task} style={styles.icon} onPress={onClose}><X size={21} color={colors.text} /></Pressable>
            <Text style={styles.title}>SSH 服务器</Text><View style={styles.icon} />
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.toggle}><Text style={styles.label}>允许当前对话使用 SSH</Text><Switch accessibilityLabel="允许当前对话使用 SSH" disabled={!!task} value={active} onValueChange={setActive} /></View>
            {field("服务器地址", profile.host, (host) => setProfile({ ...profile, host }))}
            {field("端口", port, setPort)}
            {field("SSH 用户名", profile.username, (username) => setProfile({ ...profile, username }))}
            {field("SHA256 主机指纹", profile.fingerprint, (fingerprint) => setProfile({ ...profile, fingerprint }))}
            <View style={styles.actions}>
              {(["password", "privateKey"] as const).map((type) => (
                <Pressable key={type} accessibilityRole="radio" accessibilityState={{ checked: profile.auth.type === type }} disabled={!!task}
                  onPress={() => setProfile({ ...profile, auth: type === "password" ? { type, password: "" } : { type, privateKey: "" } })}
                  style={[styles.button, profile.auth.type === type && styles.selected]}><Text style={styles.label}>{type === "password" ? "密码" : "私钥"}</Text></Pressable>
              ))}
            </View>
            {profile.auth.type === "password"
              ? field("密码", profile.auth.password, (password) => setProfile({ ...profile, auth: { type: "password", password } }), true)
              : <>
                {field("私钥", profile.auth.privateKey, (privateKey) => setProfile({ ...profile, auth: { ...profile.auth, type: "privateKey", privateKey } }), false, true)}
                {field("私钥口令（可空）", profile.auth.passphrase ?? "", (passphrase) => {
                  if (profile.auth.type === "privateKey") setProfile({ ...profile, auth: { ...profile.auth, passphrase: passphrase || undefined } });
                }, true)}
              </>}
            <View style={styles.actions}>
              <Pressable accessibilityRole="button" disabled={!!task} onPress={() => void perform("test")} style={styles.button}><Text style={styles.label}>测试连接</Text></Pressable>
              <Pressable accessibilityRole="button" disabled={!!task} onPress={() => void perform("save")} style={[styles.button, styles.primary]}><Text style={styles.primaryText}>保存</Text></Pressable>
              {task ? <ActivityIndicator color={colors.secondary} /> : null}
            </View>
            {notice ? <Text style={styles.label}>{notice}</Text> : null}
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 56, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { color: colors.text, fontWeight: "600", fontSize: 16 },
  content: { alignSelf: "center", width: "100%", maxWidth: 600, padding: 18, gap: 14 },
  field: { gap: 5 },
  label: { color: colors.text, fontSize: 15 },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 11, color: colors.text, fontSize: 15 },
  multiline: { minHeight: 100, maxHeight: 190, textAlignVertical: "top", fontFamily: "monospace" },
  toggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  actions: { flexDirection: "row", alignItems: "center", gap: 8 },
  button: { minHeight: 44, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, borderRadius: 10, justifyContent: "center" },
  selected: { backgroundColor: colors.tint },
  primary: { backgroundColor: colors.accent },
  primaryText: { color: colors.accentInk, fontSize: 15, fontWeight: "500" },
  error: { color: colors.error, fontSize: 14 },
});
