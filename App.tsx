import { useState } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from "@assistant-ui/react-native";
import { ChevronDown, Menu, Settings2 } from "lucide-react-native";
import { ConversationDrawer } from "./src/conversation-drawer";
import { ModelSheet } from "./src/model-sheet";
import { demoPrompt, Thread } from "./src/thread";
import { colors } from "./src/theme";
import { useLocalChat } from "./src/use-local-chat";

const convertMessage = (message: ThreadMessageLike) => message;
type ChatState = ReturnType<typeof useLocalChat>;
type Panel = "history" | "settings" | "models";

function ChatRuntime({ chat, onModels }: { chat: ChatState; onModels: () => void }) {
  const runtime = useExternalStoreRuntime({
    messages: chat.messages,
    convertMessage,
    isRunning: chat.running,
    isDisabled: !chat.canSend || chat.busy,
    onNew: async (message: AppendMessage) => {
      await chat.send(message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""));
    },
    onCancel: async () => { chat.stop(); },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread ready={chat.ready} canSend={chat.canSend} running={chat.running} busy={chat.busy} demo={!chat.current?.model}
        error={chat.error} onModels={onModels} onRetry={chat.retry} onTryDemo={() => { void chat.send(demoPrompt); }} />
    </AssistantRuntimeProvider>
  );
}

function Chat() {
  const chat = useLocalChat();
  const [panel, setPanel] = useState<Panel | null>(null);
  const locked = !chat.ready || chat.running || chat.busy;

  function show(next: Panel) {
    if (locked && next !== "history") return;
    Keyboard.dismiss();
    setPanel(next);
  }

  function close() { setPanel(null); }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.safe}>
        <View style={styles.layout}>
          <View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel="打开对话列表" onPress={() => show("history")} style={({ pressed }) => [styles.icon, pressed && styles.pressed]}>
              <Menu size={23} color={colors.text} />
            </Pressable>
            <View style={styles.brand}>
              <Text style={styles.logo}>Lyra</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="选择模型" disabled={locked} onPress={() => show("models")} style={({ pressed }) => [styles.model, pressed && styles.pressed]}>
                <Text style={styles.modelLabel} numberOfLines={1}>{chat.current?.model ? chat.canSend ? chat.current.model.model : "模型不可用" : "体验模式"}</Text>
                <ChevronDown size={13} color={colors.accent} />
              </Pressable>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="设置" disabled={locked} onPress={() => show("settings")} style={({ pressed }) => [styles.settings, locked && styles.disabled, pressed && styles.pressed]}>
              <Settings2 size={18} color={colors.accent} /><Text style={styles.settingsLabel}>设置</Text>
            </Pressable>
          </View>
          {chat.ready && !chat.canSend && chat.messages.length ? (
            <Pressable accessibilityRole="button" onPress={() => show("models")} style={styles.modelMissing}>
              <Text style={styles.settingsLabel}>当前模型不可用，点此重新选择</Text><ChevronDown size={15} color={colors.accent} />
            </Pressable>
          ) : null}
          <ChatRuntime key={chat.current?.id ?? "loading"} chat={chat} onModels={() => show("models")} />
        </View>
      </KeyboardAvoidingView>
      {panel === "history" ? (
        <ConversationDrawer currentId={chat.current?.id} conversations={chat.conversations} disabled={locked} onClose={close}
          onSettings={() => show("settings")} onNew={chat.startChat} onOpen={chat.openChat} onRename={chat.renameChat} onDelete={chat.deleteChat} />
      ) : null}
      {panel === "settings" || panel === "models" ? (
        <ModelSheet initialPage={panel} providers={chat.providers} current={chat.current?.model ?? null} onClose={close}
          onSelect={chat.chooseModel} onSave={chat.updateProvider} onDelete={chat.deleteProvider} />
      ) : null}
    </SafeAreaView>
  );
}

export default function App() {
  return <SafeAreaProvider><Chat /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  layout: { flex: 1, width: "100%", maxWidth: 700, alignSelf: "center" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, minHeight: 57, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface, gap: 7 },
  brand: { flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 7 },
  logo: { color: colors.text, fontSize: 24, fontWeight: "700", letterSpacing: -0.9 },
  icon: { height: 44, width: 44, justifyContent: "center", alignItems: "center", borderRadius: 12 },
  model: { maxWidth: "74%", flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 3, minHeight: 34, paddingHorizontal: 8, borderRadius: 8, backgroundColor: colors.tint },
  modelLabel: { color: colors.accent, fontSize: 13, fontWeight: "600", flexShrink: 1 },
  settings: { flexDirection: "row", alignItems: "center", minHeight: 44, gap: 6, paddingHorizontal: 7, borderRadius: 10 },
  settingsLabel: { color: colors.accent, fontWeight: "600", fontSize: 14 },
  modelMissing: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: 10, backgroundColor: colors.tint },
  disabled: { opacity: 0.45 },
  pressed: { backgroundColor: colors.raised },
});
