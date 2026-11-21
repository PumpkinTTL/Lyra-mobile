import { useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { ChainOfThoughtPrimitive, ErrorPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react-native";
import { Activity, Brain, Check, ChevronDown, File, Settings2, Terminal, TriangleAlert } from "lucide-react-native";
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
    <ChainOfThoughtPrimitive.Root>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => [styles.eventHeader, pressed && styles.pressed]}>
        <Brain size={16} color={colors.secondary} />
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
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => [styles.eventHeader, (pressed || expanded) && styles.pressed]}>
        <Terminal size={16} color={colors.secondary} />
        <View style={styles.eventCaption}>
          <Text style={styles.toolName}>{toolLabels[name] ?? name}</Text>
          {argLabel ? <Text style={styles.eventArgument} numberOfLines={1}>{argLabel}</Text> : null}
        </View>
        {state === "error" ? <TriangleAlert size={17} color={colors.error} /> :
          state === "done" ? <Check size={14} color={colors.secondary} /> : <ActivityIndicator size="small" color={colors.secondary} />}
        <ChevronDown size={15} color={colors.secondary} style={expanded ? styles.up : undefined} />
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
      <Text style={styles.title}>{ready ? "今天想做什么？" : error ? "本地数据载入失败" : "正在载入对话…"}</Text>
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
  const [footerHeight, setFooterHeight] = useState(142);
  const showActivity = props.composer.running && props.phase !== "writing";
  return (
    <ThreadPrimitive.Root style={styles.root}>
      <ThreadPrimitive.MessagesFlatList style={styles.list} contentContainerStyle={[styles.messages, { paddingBottom: footerHeight }]}
        ListEmptyComponent={<Welcome {...props} />} autoScroll scrollToBottomOnRunStart keyboardShouldPersistTaps="handled"
        ListFooterComponent={showActivity ? (
          <View style={styles.activity} accessibilityLiveRegion="polite">
            <Activity size={15} color={colors.accent} />
            <Text style={styles.detail}>{phaseLabels[props.phase]}</Text>
          </View>
        ) : undefined}>
        {({ message }) => message.role === "user" ? <UserMessage /> :
          <AssistantMessage runs={props.toolRuns} thinking={props.composer.running && props.phase === "thinking" && message.status?.type === "running"} />}
      </ThreadPrimitive.MessagesFlatList>
      <View pointerEvents="box-none" style={styles.floatingComposer} onLayout={(event) => setFooterHeight(Math.ceil(event.nativeEvent.layout.height))}>
        {props.error ? <Text accessibilityRole="alert" style={styles.threadError}>{props.error}</Text> : null}
        <ChatComposer {...props.composer} />
      </View>
    </ThreadPrimitive.Root>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { flex: 1 },
  messages: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 16, gap: 22 },
  floatingComposer: { position: "absolute", bottom: 0, left: 0, right: 0, paddingTop: 12, paddingBottom: 8, paddingHorizontal: 16, backgroundColor: colors.background },
  welcome: { flex: 1, justifyContent: "center", alignItems: "center", paddingBottom: 24, paddingHorizontal: 16, gap: 16 },
  title: { color: colors.text, fontSize: 24, fontWeight: "500", textAlign: "center", letterSpacing: -0.3 },
  connect: { minHeight: 44, borderRadius: 20, paddingHorizontal: 15, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.accent },
  connectText: { color: colors.accentInk, fontSize: 14, fontWeight: "500" },
  userBubble: { alignSelf: "flex-end", maxWidth: "85%", backgroundColor: colors.raised, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 14, gap: 7 },
  messageText: { color: colors.text, fontSize: 16, lineHeight: 24 },
  attachment: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 25 },
  image: { width: 232, height: 157, maxWidth: "100%", backgroundColor: colors.raised, borderRadius: 10 },
  reply: { alignSelf: "stretch", gap: 4 },
  eventHeader: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 8 },
  pressed: { backgroundColor: colors.tint },
  eventCaption: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  eventTitle: { color: colors.secondary, fontSize: 14, flex: 1 },
  toolName: { color: colors.text, fontSize: 14 },
  eventArgument: { color: colors.secondary, fontSize: 13, flex: 1 },
  payload: { paddingLeft: 32, paddingRight: 8, paddingVertical: 6, gap: 6 },
  detail: { color: colors.secondary, fontSize: 13, lineHeight: 19 },
  code: { padding: 8, backgroundColor: colors.raised, color: colors.text, fontFamily: "monospace", fontSize: 12, lineHeight: 18, borderRadius: 7 },
  progress: { marginLeft: 36, marginBottom: 8, color: colors.secondary, fontSize: 13 },
  up: { transform: [{ rotate: "180deg" }] },
  activity: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 28 },
  error: { color: colors.error, lineHeight: 21 },
  threadError: { marginHorizontal: 18, marginBottom: 4, color: colors.error, fontSize: 14 },
});
