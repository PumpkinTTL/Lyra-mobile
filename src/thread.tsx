import { useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { ChainOfThoughtPrimitive, ErrorPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react-native";
import { Activity, Brain, Check, ChevronDown, File, FolderOpen, Settings2, Terminal, TriangleAlert } from "lucide-react-native";
import { useMarkdown } from "react-native-marked";
import { ChatComposer, type ComposerProps } from "./chat-composer";
import type { AgentPhase, ToolRun } from "./chat-messages";
import { toolLabels } from "./workspace-tools";
import { colors } from "./theme";

type Props = {
  ready: boolean;
  canSend: boolean;
  error: string;
  phase: AgentPhase;
  toolRuns: Record<string, ToolRun>;
  onRetry(): void;
  composer: ComposerProps;
};

const markdownStyles = {
  text: { color: colors.text, fontSize: 16, lineHeight: 25 },
  link: { color: colors.accent },
  paragraph: { paddingTop: 0, paddingBottom: 6 },
  code: { backgroundColor: colors.raised },
  codespan: { color: colors.accent },
  codeText: { color: colors.text },
};

function MarkdownText({ text }: { text: string }) {
  const content = useMarkdown(text, { colorScheme: "light", styles: markdownStyles });
  return <View>{content}</View>;
}

function MessageImage({ uri }: { uri: string }) {
  return <Image accessibilityLabel="图片附件" source={{ uri }} resizeMode="contain" style={styles.image} />;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root style={styles.userBubble}>
      <MessagePrimitive.Content
        renderText={({ part }) => <Text selectable style={styles.messageText}>{part.text}</Text>}
        renderImage={({ part }) => <MessageImage uri={part.image} />}
        renderFile={({ part }) => (
          <View style={styles.attachment}><File size={16} color={colors.accent} /><Text style={styles.detail} numberOfLines={2}>{part.filename ?? part.data}</Text></View>
        )}
      />
    </MessagePrimitive.Root>
  );
}

function Reasoning({ text, active }: { text: string; active: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ChainOfThoughtPrimitive.Root style={styles.event}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={styles.eventHeader}>
        <Brain size={18} color={colors.accent} />
        <Text style={styles.eventTitle}>{active ? "思考中" : "思考过程"}</Text>
        {active ? <ActivityIndicator size="small" color={colors.accent} /> : null}
        <ChevronDown size={17} color={colors.secondary} style={expanded ? styles.up : undefined} />
      </Pressable>
      {expanded ? <View style={styles.payload}><MarkdownText text={text} /></View> : null}
    </ChainOfThoughtPrimitive.Root>
  );
}

function ToolCard({ name, run, result, failed, args }: { name: string; run?: ToolRun; result?: unknown; failed?: boolean; args: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const state = failed || run?.state === "error" ? "error" : result !== undefined || run?.state === "done" ? "done" : "running";
  const output = typeof result === "string" ? result : result && typeof result === "object" && "text" in result ? String(result.text ?? "") : "";
  const images = result && typeof result === "object" && "images" in result && Array.isArray(result.images)
    ? result.images.filter((image): image is string => typeof image === "string") : [];
  const argLabel = args && typeof args === "object"
    ? (("path" in args && typeof args.path === "string" && args.path) || ("command" in args && typeof args.command === "string" && args.command)) : null;
  return (
    <View style={styles.event}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={styles.eventHeader}>
        <Terminal size={17} color={colors.accent} />
        <View style={styles.eventCaption}>
          <Text style={styles.eventTitle}>{toolLabels[name] ?? name}</Text>
          {argLabel ? <Text style={styles.detail} numberOfLines={1}>{argLabel}</Text> : null}
        </View>
        {state === "error" ? <TriangleAlert size={17} color={colors.error} /> :
          state === "done" ? <Check size={18} color={colors.accent} /> : <ActivityIndicator size="small" color={colors.accent} />}
        <ChevronDown size={17} color={colors.secondary} style={expanded ? styles.up : undefined} />
      </Pressable>
      {run?.output && state === "running" ? <Text accessibilityLiveRegion="polite" style={styles.progress}>{run.output}</Text> : null}
      {expanded ? (
        <View style={styles.payload}>
          {args && typeof args === "object" && Object.keys(args).length ? <Text selectable style={styles.code}>{JSON.stringify(args, null, 2).slice(0, 4200)}</Text> : null}
          {output ? <Text selectable style={[styles.code, state === "error" && styles.error]}>{output}</Text> : null}
          {images.map((uri, index) => <MessageImage key={index} uri={uri} />)}
          {run?.duration !== undefined ? <Text style={styles.detail}>用时 {run.duration} ms</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function AssistantMessage({ runs, thinking }: { runs: Record<string, ToolRun>; thinking: boolean }) {
  return (
    <MessagePrimitive.Root style={styles.reply}>
      <MessagePrimitive.Content
        renderText={({ part }) => <MarkdownText text={part.text} />}
        renderReasoning={({ part }) => <Reasoning text={part.text} active={thinking} />}
        renderToolCall={({ part }) => (
          <ToolCard name={part.toolName} args={part.args} run={runs[part.toolCallId]} result={part.result} failed={part.isError} />
        )}
      />
      <ErrorPrimitive.Root><ErrorPrimitive.Message style={styles.error} /></ErrorPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function Welcome({ ready, canSend, error, onRetry, composer }: Props) {
  return (
    <View style={styles.welcome}>
      <View style={styles.welcomeIcon}><FolderOpen size={27} color={colors.accent} strokeWidth={1.75} /></View>
      <Text style={styles.title}>开始对话</Text>
      <Text style={styles.subtitle}>{!ready ? error ? "本地数据载入失败" : "正在载入本机会话…" : canSend
        ? "选择工作区，再告诉 Lyra 要完成的任务。"
        : "连接模型后，Lyra 可以在手机上处理工作区文件。"}</Text>
      {!ready && error ? (
        <Pressable accessibilityRole="button" onPress={onRetry} style={styles.connect}><Text style={styles.connectText}>重试</Text></Pressable>
      ) : null}
      {ready && !canSend ? (
        <Pressable accessibilityRole="button" onPress={composer.onModels} style={styles.connect}>
          <Settings2 size={17} color={colors.accentInk} /><Text style={styles.connectText}>选择或添加模型</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const phaseLabels: Record<AgentPhase, string> = { waiting: "等待模型响应", thinking: "思考中", tool: "正在调用工具", writing: "正在生成回复" };

export function Thread(props: Props) {
  const showActivity = props.composer.running && props.phase !== "writing";
  return (
    <ThreadPrimitive.Root style={styles.root}>
      <ThreadPrimitive.MessagesFlatList style={styles.list} contentContainerStyle={styles.messages} ListEmptyComponent={<Welcome {...props} />}
        autoScroll keyboardShouldPersistTaps="handled"
        ListFooterComponent={showActivity ? (
          <View style={styles.activity} accessibilityLiveRegion="polite">
            <Activity size={15} color={colors.accent} />
            <Text style={styles.detail}>{phaseLabels[props.phase]}</Text>
          </View>
        ) : undefined}>
        {({ message }) => message.role === "user" ? <UserMessage /> :
          <AssistantMessage runs={props.toolRuns} thinking={props.composer.running && props.phase === "thinking" && message.status?.type === "running"} />}
      </ThreadPrimitive.MessagesFlatList>
      {props.error ? <Text accessibilityRole="alert" style={styles.threadError}>{props.error}</Text> : null}
      <ChatComposer {...props.composer} />
    </ThreadPrimitive.Root>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { flex: 1 },
  messages: { flexGrow: 1, paddingHorizontal: 18, paddingVertical: 16, gap: 16 },
  welcome: { flex: 1, justifyContent: "center", alignItems: "center", paddingBottom: 26, paddingHorizontal: 14 },
  welcomeIcon: { width: 58, height: 58, borderRadius: 17, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, justifyContent: "center", alignItems: "center", marginBottom: 16 },
  title: { color: colors.text, fontSize: 26, fontWeight: "700", textAlign: "center", marginBottom: 7 },
  subtitle: { color: colors.secondary, fontSize: 15, lineHeight: 22, textAlign: "center", marginBottom: 18 },
  connect: { minHeight: 44, borderRadius: 12, paddingHorizontal: 15, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.accent },
  connectText: { color: colors.accentInk, fontSize: 15, fontWeight: "600" },
  userBubble: { alignSelf: "flex-end", maxWidth: "90%", backgroundColor: colors.raised, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16, borderBottomRightRadius: 5, gap: 7 },
  messageText: { color: colors.text, fontSize: 16, lineHeight: 24 },
  attachment: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 25 },
  image: { width: 232, height: 157, maxWidth: "100%", backgroundColor: colors.raised, borderRadius: 10 },
  reply: { alignSelf: "stretch", gap: 7 },
  event: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 13, overflow: "hidden" },
  eventHeader: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 43, paddingVertical: 9, paddingHorizontal: 11 },
  eventCaption: { flex: 1, gap: 2 },
  eventTitle: { color: colors.text, fontSize: 14, fontWeight: "600", flex: 1 },
  payload: { paddingHorizontal: 11, paddingBottom: 11, gap: 6 },
  detail: { color: colors.secondary, fontSize: 13, lineHeight: 19 },
  code: { padding: 8, backgroundColor: colors.raised, color: colors.text, fontFamily: "monospace", fontSize: 12, lineHeight: 18, borderRadius: 7 },
  progress: { marginLeft: 36, marginBottom: 8, color: colors.secondary, fontSize: 13 },
  up: { transform: [{ rotate: "180deg" }] },
  activity: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 28 },
  error: { color: colors.error, lineHeight: 21 },
  threadError: { marginHorizontal: 18, marginBottom: 4, color: colors.error, fontSize: 14 },
});
