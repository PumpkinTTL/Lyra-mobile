import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowLeft, ChevronRight, Plus, Server, Trash2, X } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { safeModelError } from "./model-catalog";
import { deleteSshProfile, loadSshProfiles, saveSshProfile, testSsh, type SavedSshProfile, type SshProfile } from "./ssh";
import { colors } from "./theme";

const initial: SshProfile = { host: "", port: 22, username: "", fingerprint: "", auth: { type: "password", password: "" } };

export function SshSheet({ onClose }: { onClose: () => void }) {
  const [profiles, setProfiles] = useState<SavedSshProfile[]>([]);
  const [profile, setProfile] = useState<SshProfile>();
  const [port, setPort] = useState("22");
  const [task, setTask] = useState<"load" | "save" | "test" | "delete" | null>("load");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    loadSshProfiles().then((saved) => {
      if (live) setProfiles(saved);
    }).catch((cause) => { if (live) setError(safeModelError(cause)); })
      .finally(() => { if (live) setTask(null); });
    return () => { live = false; };
  }, []);

  async function perform(action: "save" | "test") {
    if (task || !profile) return;
    setNotice(""); setError(""); setTask(action);
    try {
      const value = { ...profile, port: Number(port) };
      if (action === "test") { await testSsh(value); setNotice("指纹校验和登录成功。"); }
      else {
        setProfiles(await saveSshProfile(value));
        setProfile(undefined);
      }
    } catch (cause) { setError(safeModelError(cause)); }
    finally { setTask(null); }
  }

  function edit(next: SshProfile) {
    setError(""); setNotice(""); setProfile(next); setPort(String(next.port));
  }

  function back() {
    if (task) return;
    if (profile) { setNotice(""); setError(""); setProfile(undefined); }
    else onClose();
  }

  function remove(id: string) {
    Alert.alert("移除 SSH 连接？", "将从本机钥匙串删除这组连接凭据。", [{ text: "取消", style: "cancel" }, {
      text: "移除", style: "destructive", onPress: () => {
        setTask("delete");
        void deleteSshProfile(id).then((next) => { setProfiles(next); setProfile(undefined); }).catch((cause) => setError(safeModelError(cause))).finally(() => setTask(null));
      },
    }]);
  }

  function field(label: string, value: string, onChangeText: (text: string) => void, secret = false, multiline = false) {
    return <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} editable={!task} value={value} onChangeText={onChangeText} autoCapitalize="none"
        autoCorrect={false} secureTextEntry={secret} multiline={multiline} style={[styles.input, multiline && styles.multiline]} />
    </View>;
  }

  return (
    <Modal animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={back}>
      <SafeAreaView style={styles.screen}>
        <KeyboardAvoidingView behavior="padding" style={styles.screen}>
          <View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel={profile ? "返回 SSH 连接" : "关闭 SSH 设置"} disabled={!!task} style={styles.icon} onPress={back}>
              {profile ? <ArrowLeft size={21} color={colors.text} /> : <X size={21} color={colors.text} />}
            </Pressable>
            <Text style={styles.title}>{profile ? profile.id ? "编辑 SSH 连接" : "添加 SSH 连接" : "SSH 连接"}</Text>
            {profile?.id ? <Pressable accessibilityRole="button" accessibilityLabel="移除 SSH 连接" style={styles.icon} disabled={!!task} onPress={() => remove(profile.id!)}><Trash2 size={18} color={colors.error} /></Pressable> : <View style={styles.icon} />}
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {!profile ? <>
              <Text style={styles.hint}>添加连接后，在任意对话里说出服务器名称和要做的事。Agent 会拟定命令供你确认。</Text>
              {profiles.map((entry) => <Pressable accessibilityRole="button" key={entry.id} disabled={!!task} onPress={() => edit(entry)} style={styles.connection}>
                <Server size={18} color={colors.secondary} /><View style={styles.grow}><Text style={styles.label}>{entry.label}</Text>
                  <Text style={styles.hint}>{entry.username}@{entry.host}:{entry.port}</Text></View><ChevronRight size={16} color={colors.secondary} />
              </Pressable>)}
              <Pressable accessibilityRole="button" disabled={!!task} onPress={() => edit(initial)} style={[styles.button, styles.connection]}>
                <Plus size={17} color={colors.text} /><Text style={styles.label}>添加 SSH 连接</Text>
              </Pressable>
            </> : <>
            {field("连接名称", profile.label ?? "", (label) => setProfile({ ...profile, label }))}
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
            </View>
            </>}
            {task ? <ActivityIndicator color={colors.secondary} /> : null}
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
  connection: { flexDirection: "row", alignItems: "center", justifyContent: "flex-start", padding: 12, gap: 12, minHeight: 50, borderWidth: 1, borderColor: colors.border, borderRadius: 10 },
  hint: { color: colors.secondary, fontSize: 13, lineHeight: 20 },
  grow: { flex: 1 },
  actions: { flexDirection: "row", alignItems: "center", gap: 8 },
  button: { minHeight: 44, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, borderRadius: 10, justifyContent: "center" },
  selected: { backgroundColor: colors.tint },
  primary: { backgroundColor: colors.accent },
  primaryText: { color: colors.accentInk, fontSize: 15, fontWeight: "500" },
  error: { color: colors.error, fontSize: 14 },
});
