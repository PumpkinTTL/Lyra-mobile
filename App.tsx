import { useState } from "react";
import { Alert, Keyboard, KeyboardAvoidingView, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from "react-native-safe-area-context";
import { AssistantRuntimeProvider, MessageNotSentError, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react-native";
import { Menu, Settings2 } from "lucide-react-native";
import { ConversationDrawer } from "./src/conversation-drawer";
import { ModelSheet } from "./src/model-sheet";
import { WorkspaceSheet } from "./src/workspace-sheet";
import { SshSheet } from "./src/ssh-sheet";
import { defaultProject, relativePath, workspaceSupported, type WorkspaceArtifact } from "./src/device-workspace";
import { safeModelError } from "./src/model-catalog";
import { Thread } from "./src/thread";
import { colors } from "./src/theme";
import { useLocalChat } from "./src/use-local-chat";

const convertMessage = (message: ThreadMessageLike) => message;
type ChatState = ReturnType<typeof useLocalChat>;
type Panel = "history" | "settings" | "models" | "workspace" | "ssh";

function ChatRuntime({ chat, show, close, historyOpen, onArtifact }: { chat: ChatState; show: (panel: Panel) => void; close: () => void;
  historyOpen: boolean; onArtifact(file: WorkspaceArtifact): void }) {
  const blocked = !chat.ready || chat.busy;

  async function switchChat(action: () => Promise<void>) {
    try {
      await action();
      close();
    } catch (error) {
      Alert.alert("切换对话失败", safeModelError(error));
    }
  }

  const runtime = useExternalStoreRuntime({
    messages: chat.messages,
    convertMessage,
    isRunning: chat.running,
    isDisabled: blocked,
    adapters: {
      threadList: {
        threadId: chat.current?.id,
        threads: chat.conversations.map(({ id, title }) => ({ id, title, status: "regular" })),
        onSwitchToNewThread: () => switchChat(chat.startChat),
        onSwitchToThread: (id) => switchChat(() => chat.openChat(id)),
      },
    },
    onNew: async (message) => {
      if (message.role !== "user") return;
      Keyboard.dismiss();
      const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
      const files = (message.attachments ?? []).flatMap((attachment) => attachment.content.flatMap((part) => {
        const size = part.type === "file" ? part.providerMetadata?.lyra?.size : undefined;
        return part.type === "file" && typeof size === "number"
          ? [{ name: attachment.name, path: part.data, mime: part.mimeType, size }]
          : [];
      }));
      if (!await chat.send(text, files)) throw new MessageNotSentError("消息未发送。");
    },
    onCancel: async () => { chat.stop(); },
    onReload: async () => { if (!await chat.regenerate()) throw new MessageNotSentError("暂时无法重新生成回复。"); },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread ready={chat.ready} canSend={chat.canSend} error={chat.error} phase={chat.phase} toolRuns={chat.toolRuns} onRetry={chat.retry}
        onArtifact={onArtifact} onContinue={() => { void chat.continueReply(); }}
        composer={{
          editable: !blocked, canSubmit: chat.canSend && !chat.runningElsewhere, running: chat.running, runningElsewhere: chat.runningElsewhere,
          modelLabel: chat.current?.model ? chat.canSend ? chat.current.model.model : "模型不可用" : "选择模型",
          projectId: chat.current?.projectId ?? defaultProject, onModels: () => show("models"), onSteer: chat.steer,
        }} />
      {historyOpen ? (
        <ConversationDrawer currentId={chat.current?.id} runningId={chat.runningId} conversations={chat.conversations} disabled={blocked}
          onClose={close} onSettings={() => show("settings")} onRename={chat.renameChat} onDelete={chat.deleteChat} />
      ) : null}
    </AssistantRuntimeProvider>
  );
}

function Chat() {
  const chat = useLocalChat();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [artifact, setArtifact] = useState<WorkspaceArtifact>();
  const locked = !chat.ready;

  function show(next: Panel) {
    if (locked && next !== "history") return;
    if (next === "workspace" && !workspaceSupported()) {
      Alert.alert("工作区", "此安装包没有工作区模块。");
      return;
    }
    Keyboard.dismiss();
    setArtifact(undefined);
    setPanel(next);
  }

  function showArtifact(file: WorkspaceArtifact) {
    try {
      const path = relativePath(file.path);
      if (!path) return;
      Keyboard.dismiss();
      setArtifact({ ...file, path });
      setPanel("workspace");
    } catch (error) { Alert.alert("打开文件", safeModelError(error)); }
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
            <Pressable accessibilityRole="button" accessibilityLabel="设置" disabled={locked} onPress={() => show("settings")} style={[styles.icon, locked && styles.disabled]}>
              <Settings2 size={21} color={colors.text} />
            </Pressable>
          </View>
          <ChatRuntime key={(chat.current?.id ?? "loading") + ":" + (chat.current?.projectId ?? defaultProject)}
            chat={chat} show={show} close={close} historyOpen={panel === "history"} onArtifact={showArtifact} />
        </View>
      </KeyboardAvoidingView>
      {panel === "settings" || panel === "models" ? (
        <ModelSheet initialPage={panel} providers={chat.providers} current={chat.current?.model ?? null} onClose={close}
          thinking={chat.current?.thinking ?? "off"} onThinking={chat.chooseThinking}
          projectName={chat.current?.projectName ?? "本机工作区"} onWorkspace={() => show("workspace")}
          running={chat.running} onSsh={() => show("ssh")}
          onSelect={chat.chooseModel} onSave={chat.updateProvider} onDelete={chat.deleteProvider} />
      ) : null}
      {panel === "workspace" ? (
        <WorkspaceSheet key={artifact?.path ?? "workspace"} current={artifact?.projectId ?? chat.current?.projectId ?? defaultProject}
          currentName={artifact?.projectId && artifact.projectId !== chat.current?.projectId ? undefined : chat.current?.projectName}
          initialPath={artifact?.path} allowProjectChange={!chat.running && !chat.busy} onClose={close} onSelect={chat.chooseProject} />
      ) : null}
      {panel === "ssh" ? <SshSheet onClose={() => setPanel("settings")} /> : null}
    </SafeAreaView>
  );
}

export default function App() {
  return <SafeAreaProvider initialMetrics={initialWindowMetrics}><Chat /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  layout: { flex: 1, width: "100%", maxWidth: 700, alignSelf: "center" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, minHeight: 52, backgroundColor: colors.background, gap: 8 },
  title: { flex: 1, textAlign: "center", color: colors.text, fontSize: 16, fontWeight: "600" },
  icon: { height: 44, width: 44, justifyContent: "center", alignItems: "center", borderRadius: 12 },
  disabled: { opacity: 0.45 },
});
