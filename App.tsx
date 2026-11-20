import { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from "@assistant-ui/react-native";
import { Settings2, SquarePen } from "lucide-react-native";
import { ModelSheet } from "./src/model-sheet";
import { demoPrompt, Thread } from "./src/thread";
import { colors } from "./src/theme";
import { useLocalChat } from "./src/use-local-chat";

const convertMessage = (message: ThreadMessageLike) => message;

function Chat() {
  const chat = useLocalChat();
  const [showSettings, setShowSettings] = useState(false);

  const runtime = useExternalStoreRuntime({
    messages: chat.messages,
    convertMessage,
    isRunning: chat.running,
    onNew: async (message: AppendMessage) => {
      await chat.send(message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""));
    },
    onCancel: async () => { chat.stop(); },
  });

  function confirmReset() {
    Alert.alert("开始新对话？", "当前模式下的本机对话会被清除。", [
      { text: "取消", style: "cancel" },
      { text: "开始新对话", style: "destructive", onPress: () => { void chat.reset(); } },
    ]);
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.safe}>
          <View style={styles.layout}>
            <View style={styles.header}>
              <View style={styles.brand}>
                <Text style={styles.logo}>Lyra</Text>
                <View style={styles.mode}>
                  <View style={styles.dot} />
                  <Text style={styles.modeLabel} numberOfLines={1}>{chat.settings?.model ?? "体验模式"}</Text>
                </View>
              </View>
              <View style={styles.actions}>
                <Pressable accessibilityRole="button" accessibilityLabel="新对话" disabled={!chat.ready || chat.running || !chat.messages.length} onPress={confirmReset} style={({ pressed }) => [styles.icon, (!chat.messages.length || chat.running) && styles.disabled, pressed && styles.pressed]}>
                  <SquarePen size={20} color={colors.text} />
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="模型设置" disabled={!chat.ready || chat.running} onPress={() => setShowSettings(true)} style={({ pressed }) => [styles.icon, chat.running && styles.disabled, pressed && styles.pressed]}>
                  <Settings2 size={20} color={colors.text} />
                </Pressable>
              </View>
            </View>
            <Thread ready={chat.ready} running={chat.running} demo={!chat.settings} error={chat.error} onTryDemo={() => { void chat.send(demoPrompt); }} />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
      {showSettings ? <ModelSheet initial={chat.settings} onClose={() => setShowSettings(false)} onSave={chat.configure} /> : null}
    </AssistantRuntimeProvider>
  );
}

export default function App() {
  return <SafeAreaProvider><Chat /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  layout: { flex: 1, width: "100%", maxWidth: 700, alignSelf: "center" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, gap: 10 },
  brand: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  logo: { color: colors.text, fontSize: 25, fontWeight: "700", letterSpacing: -0.9 },
  mode: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  modeLabel: { color: colors.secondary, fontSize: 13, flexShrink: 1 },
  actions: { flexDirection: "row", alignItems: "center", gap: 4 },
  icon: { height: 44, width: 44, justifyContent: "center", alignItems: "center", borderRadius: 12 },
  disabled: { opacity: 0.42 },
  pressed: { backgroundColor: colors.raised },
});
