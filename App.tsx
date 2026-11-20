import { useState } from "react";
import { Alert, Keyboard, KeyboardAvoidingView, Modal, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from "@assistant-ui/react-native";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Check, Menu, Settings2, X } from "lucide-react-native";
import { ConversationDrawer } from "./src/conversation-drawer";
import { ModelSheet } from "./src/model-sheet";
import { WorkspaceSheet } from "./src/workspace-sheet";
import { defaultProject, pickAttachments, workspaceSupported, type WorkspaceAttachment } from "./src/device-workspace";
import { safeModelError } from "./src/model-catalog";
import { Thread } from "./src/thread";
import { colors } from "./src/theme";
import { useLocalChat } from "./src/use-local-chat";

const convertMessage = (message: ThreadMessageLike) => message;
type ChatState = ReturnType<typeof useLocalChat>;
type Panel = "history" | "settings" | "models" | "workspace" | "thinking";
const levels: Record<ThinkingLevel, string> = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };

function ChatRuntime({ chat, show }: { chat: ChatState; show: (panel: Panel) => void }) {
  const [attachments, setAttachments] = useState<WorkspaceAttachment[]>([]);
  const [picking, setPicking] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const blocked = !chat.canSend || chat.busy || picking;

  async function send(text: string) {
    if (picking) return;
    setAttachmentError("");
    if (await chat.send(text, attachments)) setAttachments([]);
  }

  async function attach() {
    if (blocked || chat.running) return;
    setAttachmentError("");
    setPicking(true);
    try {
      const files = await pickAttachments(chat.current?.projectId ?? defaultProject);
      if (!files) return;
      if (attachments.length + files.length > 6) throw new Error("一条消息最多添加 6 个附件。");
      setAttachments((previous) => [...previous, ...files]);
    } catch (error) {
      setAttachmentError(safeModelError(error));
    } finally {
      setPicking(false);
    }
  }

  const runtime = useExternalStoreRuntime({
    messages: chat.messages,
    convertMessage,
    isRunning: chat.running,
    isDisabled: blocked,
    onNew: async (message: AppendMessage) => {
      await send(message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""));
    },
    onCancel: async () => { chat.stop(); },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread ready={chat.ready} canSend={chat.canSend} error={attachmentError || chat.error} phase={chat.phase} toolRuns={chat.toolRuns} onRetry={chat.retry}
        composer={{
          editable: !blocked, running: chat.running, modelLabel: chat.current?.model ? chat.canSend ? chat.current.model.model : "模型不可用" : "选择模型",
          thinkingLabel: levels[chat.current?.thinking ?? "off"], projectName: chat.current?.projectName ?? "本机工作区", attachments,
          onModels: () => show("models"), onThinking: () => show("thinking"), onWorkspace: () => show("workspace"),
          onPickAttachments: () => { void attach(); }, onRemoveAttachment: (path) => setAttachments((items) => items.filter((item) => item.path !== path)),
          onSendAttachments: () => { void send(""); },
        }} />
    </AssistantRuntimeProvider>
  );
}

function ThinkingSheet({ current, onSelect, onClose }: { current: ThinkingLevel; onSelect(level: ThinkingLevel): void; onClose(): void }) {
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭思考级别" onPress={onClose} style={styles.icon}><X size={22} color={colors.text} /></Pressable>
          <Text style={styles.title}>思考级别</Text><View style={styles.icon} />
        </View>
        <ScrollView contentContainerStyle={styles.options}>
          <Text style={styles.hint}>只有支持推理的模型才会返回思考过程。</Text>
          {(Object.keys(levels) as ThinkingLevel[]).map((level) => (
            <Pressable key={level} accessibilityRole="radio" accessibilityState={{ checked: current === level }}
              onPress={() => onSelect(level)} style={[styles.option, current === level && styles.selected]}>
              <Text style={styles.optionLabel}>{levels[level]}</Text>
              {current === level ? <Check color={colors.accent} size={19} /> : null}
            </Pressable>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Chat() {
  const chat = useLocalChat();
  const [panel, setPanel] = useState<Panel | null>(null);
  const locked = !chat.ready || chat.running || chat.busy;

  function show(next: Panel) {
    if (locked && next !== "history") return;
    if (next === "workspace" && !workspaceSupported()) {
      Alert.alert("工作区", "此安装包没有工作区模块。");
      return;
    }
    Keyboard.dismiss();
    setPanel(next);
  }

  function close() { setPanel(null); }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <KeyboardAvoidingView behavior="padding" style={styles.safe}>
        <View style={styles.layout}>
          <View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel="打开对话列表" onPress={() => show("history")} style={styles.icon}>
              <Menu size={23} color={colors.text} />
            </Pressable>
            <Text style={styles.title} numberOfLines={1}>{chat.current?.title || "Lyra"}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="设置" disabled={locked} onPress={() => show("settings")} style={[styles.settings, locked && styles.disabled]}>
              <Settings2 size={19} color={colors.text} /><Text style={styles.settingsLabel}>设置</Text>
            </Pressable>
          </View>
          <ChatRuntime key={(chat.current?.id ?? "loading") + ":" + (chat.current?.projectId ?? defaultProject)} chat={chat} show={show} />
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
      {panel === "workspace" ? <WorkspaceSheet current={chat.current?.projectId ?? defaultProject} onClose={close} onSelect={chat.chooseProject} /> : null}
      {panel === "thinking" ? (
        <ThinkingSheet current={chat.current?.thinking ?? "off"} onClose={close}
          onSelect={(level) => { void chat.chooseThinking(level).then(close).catch((error) => Alert.alert("思考级别", safeModelError(error))); }} />
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
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 11, minHeight: 55, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface, gap: 6 },
  title: { flex: 1, textAlign: "center", color: colors.text, fontSize: 19, fontWeight: "700" },
  icon: { height: 44, width: 44, justifyContent: "center", alignItems: "center", borderRadius: 12 },
  settings: { flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: 6, gap: 5 },
  settingsLabel: { color: colors.text, fontWeight: "600", fontSize: 14 },
  disabled: { opacity: 0.45 },
  options: { width: "100%", maxWidth: 600, alignSelf: "center", padding: 17, gap: 8 },
  hint: { color: colors.secondary, fontSize: 14, marginBottom: 5 },
  option: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 47, paddingHorizontal: 13, borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  optionLabel: { color: colors.text, fontSize: 15 },
  selected: { backgroundColor: colors.tint, borderColor: colors.tintBorder },
});
