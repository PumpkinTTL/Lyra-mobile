import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { X } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { safeModelError } from "./model-catalog";
import { normalizeSshProfile, type AuthorizeSsh, type SshCommand, type SshProfile } from "./ssh";
import { colors } from "./theme";

type Approval = { id: number; command: SshCommand; respond(profile?: SshProfile): void };

export function useSshApproval() {
  const [approval, setApproval] = useState<Approval>();
  const pending = useRef<Approval>(undefined);
  const nextId = useRef(0);
  useEffect(() => () => pending.current?.respond(), []);

  const authorize: AuthorizeSsh = useCallback((command, signal) => new Promise((resolve) => {
    if (signal.aborted || pending.current) { resolve(undefined); return; }
    const id = ++nextId.current;
    const cancel = () => respond();
    function respond(profile?: SshProfile) {
      if (pending.current?.id !== id) return;
      pending.current = undefined;
      signal.removeEventListener("abort", cancel);
      setApproval(undefined);
      resolve(profile);
    }
    const request = { id, command, respond };
    pending.current = request;
    signal.addEventListener("abort", cancel, { once: true });
    setApproval(request);
  }), []);

  return { approval, authorize };
}

function Field({ label, style, ...props }: TextInputProps & { label: string }) {
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} autoCapitalize="none" autoCorrect={false} autoComplete="off"
      importantForAutofill="no" style={[styles.input, style]} {...props} />
  </View>;
}

export function SshSheet({ approval }: { approval: Approval }) {
  const { command, respond } = approval;
  const [host, setHost] = useState(command.host);
  const [port, setPort] = useState(String(command.port));
  const [username, setUsername] = useState(command.username);
  const [fingerprint, setFingerprint] = useState("");
  const [authType, setAuthType] = useState<SshProfile["auth"]["type"]>("password");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");

  function close() {
    Keyboard.dismiss();
    respond();
  }

  function confirm() {
    try {
      const profile = normalizeSshProfile({ host, port: Number(port), username, fingerprint,
        auth: authType === "password" ? { type: "password", password: secret }
          : { type: "privateKey", privateKey: secret.trim(), passphrase: passphrase || undefined } });
      Keyboard.dismiss();
      respond(profile);
    } catch (cause) { setError(safeModelError(cause)); }
  }

  return (
    <Modal animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
      <SafeAreaView style={styles.screen}>
        <KeyboardAvoidingView behavior="padding" style={styles.screen}>
          <View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel="取消 SSH 请求" style={styles.icon} onPress={close}>
              <X size={21} color={colors.text} />
            </Pressable>
            <Text style={styles.title}>确认 SSH 命令</Text>
            <View style={styles.icon} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <View style={styles.field}>
              <Text style={styles.label}>即将执行</Text>
              <Text selectable style={styles.command}>{command.command}</Text>
              <Text style={styles.hint}>凭据只用于这次执行，连接结束后清除。</Text>
            </View>
            <View style={styles.address}>
              <View style={styles.grow}><Field label="服务器地址" value={host} onChangeText={setHost} /></View>
              <View style={styles.port}><Field label="端口" value={port} onChangeText={setPort} keyboardType="number-pad" /></View>
            </View>
            <Field label="SSH 用户名" value={username} onChangeText={setUsername} />
            <Field label="SHA256 主机指纹" value={fingerprint} onChangeText={setFingerprint} />
            <View style={styles.actions}>
              {(["password", "privateKey"] as const).map((type) => (
                <Pressable key={type} accessibilityRole="radio" accessibilityState={{ checked: authType === type }}
                  onPress={() => { if (authType !== type) { setAuthType(type); setSecret(""); setPassphrase(""); } }}
                  style={[styles.button, authType === type && styles.selected]}>
                  <Text style={styles.label}>{type === "password" ? "密码" : "私钥"}</Text>
                </Pressable>
              ))}
            </View>
            {authType === "password" ? <Field key={authType} label="密码" value={secret} onChangeText={setSecret} secureTextEntry />
              : <>
                <Field key={authType} label="私钥" value={secret} onChangeText={setSecret} multiline style={styles.multiline} />
                <Field label="私钥口令（可空）" value={passphrase} onChangeText={setPassphrase} secureTextEntry />
              </>}
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            <Pressable accessibilityRole="button" onPress={confirm} style={[styles.button, styles.primary]}>
              <Text style={styles.primaryText}>确认并执行</Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 52, paddingHorizontal: 12 },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { color: colors.text, fontWeight: "600", fontSize: 16 },
  content: { alignSelf: "center", width: "100%", maxWidth: 560, paddingHorizontal: 20, paddingVertical: 12, gap: 16 },
  field: { gap: 5 },
  label: { color: colors.text, fontSize: 14, fontWeight: "500" },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 11, color: colors.text, fontSize: 15 },
  multiline: { minHeight: 90, maxHeight: 155, textAlignVertical: "top", fontFamily: "monospace" },
  hint: { color: colors.secondary, fontSize: 13, lineHeight: 20 },
  command: { color: colors.text, fontSize: 14, lineHeight: 22, fontFamily: "monospace", paddingVertical: 4 },
  address: { flexDirection: "row", alignItems: "center", gap: 10 },
  grow: { flex: 1 },
  port: { width: 76 },
  actions: { flexDirection: "row", gap: 8 },
  button: { minHeight: 44, paddingHorizontal: 15, borderRadius: 10, justifyContent: "center", alignItems: "center" },
  selected: { backgroundColor: colors.raised },
  primary: { alignSelf: "flex-start", backgroundColor: colors.accent },
  primaryText: { color: colors.accentInk, fontSize: 14, fontWeight: "600" },
  error: { color: colors.error, fontSize: 14 },
});

