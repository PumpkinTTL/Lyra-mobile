import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ComposerPrimitive, ErrorPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react-native";
import { ArrowUp, BookOpen, Check, ChevronRight, Square, TriangleAlert } from "lucide-react-native";
import { useMarkdown } from "react-native-marked";
import { colors } from "./theme";

export const demoPrompt = "读取手机中的示例笔记，告诉我下一步。";

type Props = {
  ready: boolean;
  running: boolean;
  demo: boolean;
  error: string;
  onTryDemo: () => void;
};

const markdownStyles = {
  text: { color: colors.text, fontSize: 16, lineHeight: 25 },
  link: { color: colors.accent },
  paragraph: { paddingTop: 0, paddingBottom: 6 },
  code: { backgroundColor: colors.surface },
  codespan: { color: colors.accent },
  codeText: { color: colors.text },
};

function MarkdownText({ text }: { text: string }) {
  const content = useMarkdown(text, { colorScheme: "dark", styles: markdownStyles });
  return <View>{content}</View>;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root style={styles.userBubble}>
      <MessagePrimitive.Content renderText={({ part }) => <Text selectable style={styles.messageText}>{part.text}</Text>} />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root style={styles.reply}>
      <MessagePrimitive.Content
        renderText={({ part }) => <MarkdownText text={part.text} />}
        renderReasoning={({ part }) => <Text style={styles.reasoning}>{part.text}</Text>}
        renderToolCall={({ part }) => {
          const finished = part.result !== undefined;
          return (
            <View style={styles.tool}>
              <View style={styles.toolHeader}>
                <BookOpen size={17} color={colors.accent} />
                <Text style={styles.toolName}>{part.toolName === "read_local_note" ? "读取本地笔记" : part.toolName}</Text>
                {part.isError ? <TriangleAlert size={16} color={colors.error} /> : finished ? <Check size={16} color={colors.accent} /> : <ActivityIndicator size="small" color={colors.secondary} />}
              </View>
              {typeof part.result === "string" && part.result ? <Text selectable style={styles.toolResult}>{part.result}</Text> : null}
            </View>
          );
        }}
      />
      <MessageError />
    </MessagePrimitive.Root>
  );
}

function MessageError() {
  const { Root, Message } = ErrorPrimitive;
  return (
    <Root>
      <Message style={styles.error} />
    </Root>
  );
}

function Welcome({ ready, running, demo, onTryDemo }: Omit<Props, "error">) {
  return (
    <View style={styles.welcome}>
      <View style={styles.welcomeIcon}><BookOpen size={25} color={colors.accent} strokeWidth={1.7} /></View>
      <Text style={styles.title}>在本机开始对话</Text>
      <Text style={styles.subtitle}>{!ready ? "正在载入本机会话…" : demo ? "用一条示例笔记体验 Pi 的工具调用。" : "输入消息开始，工具将在这台手机上执行。"}</Text>
      {ready && demo ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="运行工具示例"
          disabled={running}
          onPress={onTryDemo}
          style={({ pressed }) => [styles.tryDemo, pressed && styles.pressed]}
        >
          <Text style={styles.tryText}>读取示例笔记</Text>
          <ChevronRight size={18} color={colors.accent} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function Thread({ ready, running, demo, error, onTryDemo }: Props) {
  return (
    <ThreadPrimitive.Root style={styles.root}>
      <ThreadPrimitive.MessagesFlatList
        style={styles.list}
        contentContainerStyle={styles.messages}
        ListEmptyComponent={<Welcome ready={ready} running={running} demo={demo} onTryDemo={onTryDemo} />}
        autoScroll
        keyboardShouldPersistTaps="handled"
      >
        {({ message }) => message.role === "user" ? <UserMessage /> : <AssistantMessage />}
      </ThreadPrimitive.MessagesFlatList>
      {error ? <Text accessibilityRole="alert" style={styles.threadError}>{error}</Text> : null}
      <ComposerPrimitive.Root style={styles.composer}>
        <ComposerPrimitive.Input
          accessibilityLabel="消息"
          placeholder="给 Lyra 发消息"
          placeholderTextColor={colors.secondary}
          editable={ready && !running}
          multiline
          style={styles.input}
        />
        {running ? (
          <ComposerPrimitive.Cancel accessibilityLabel="停止生成" style={styles.send}>
            <Square size={17} fill={colors.accentInk} color={colors.accentInk} />
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send accessibilityLabel="发送消息" style={({ pressed }) => [styles.send, pressed && styles.pressed]}>
            <ArrowUp size={22} color={colors.accentInk} strokeWidth={2.4} />
          </ComposerPrimitive.Send>
        )}
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}


const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { flex: 1 },
  messages: { flexGrow: 1, paddingHorizontal: 20, paddingVertical: 16, gap: 18 },
  welcome: { flex: 1, justifyContent: "center", alignItems: "center", paddingBottom: 44, paddingHorizontal: 15 },
  welcomeIcon: { width: 56, height: 56, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, justifyContent: "center", alignItems: "center", marginBottom: 18 },
  title: { color: colors.text, fontSize: 25, fontWeight: "600", textAlign: "center", marginBottom: 8 },
  subtitle: { color: colors.secondary, fontSize: 15, lineHeight: 23, textAlign: "center", marginBottom: 22 },
  tryDemo: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 46, paddingHorizontal: 15, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  tryText: { color: colors.text, fontWeight: "500" },
  pressed: { opacity: 0.75 },
  userBubble: { alignSelf: "flex-end", maxWidth: "90%", backgroundColor: colors.raised, paddingHorizontal: 15, paddingVertical: 10, borderRadius: 16, borderBottomRightRadius: 5 },
  messageText: { color: colors.text, fontSize: 16, lineHeight: 24 },
  reply: { alignSelf: "stretch", gap: 8 },
  reasoning: { color: colors.secondary, fontSize: 14, lineHeight: 22 },
  tool: { marginBottom: 8, padding: 12, gap: 8, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  toolHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  toolName: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "600" },
  toolResult: { color: colors.secondary, fontSize: 13, lineHeight: 20 },
  error: { color: colors.error, lineHeight: 21 },
  threadError: { marginHorizontal: 20, marginTop: 4, color: colors.error, fontSize: 14 },
  composer: { margin: 12, marginHorizontal: 16, flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 21 },
  input: { flex: 1, minHeight: 42, maxHeight: 128, paddingVertical: 10, paddingHorizontal: 8, color: colors.text, fontSize: 16 },
  send: { width: 42, height: 42, borderRadius: 14, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
});
