import { useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { ActionBarPrimitive, ChainOfThoughtPrimitive, ErrorPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react-native";
import { Activity, Brain, Check, ChevronDown, ChevronRight, Copy, File, RotateCcw, Settings2, Terminal, TriangleAlert } from "lucide-react-native";
import { useMarkdown } from "react-native-marked";
import { ChatComposer, type ComposerProps } from "./chat-composer";
import { toolArtifacts, type AgentPhase, type ToolRun } from "./chat-messages";
import { copyText, type WorkspaceArtifact } from "./device-workspace";
import { toolLabels } from "./workspace-tools";
import { colors } from "./theme";

type Props = {
  ready: boolean;
  canSend: boolean;
  error: string;
  phase: AgentPhase;
  toolRuns: Record<string, ToolRun>;
  onRetry(): void;
  onContinue(): void;
  onArtifact(file: WorkspaceArtifact): void;
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

function FileLink({ file, name, onOpen }: { file: WorkspaceArtifact; name?: string; onOpen(file: WorkspaceArtifact): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={"预览文件 " + (name ?? file.path)}
    onPress={() => onOpen(file)} style={({ pressed }) => [styles.artifact, pressed && styles.pressed]}>
    <File size={16} color={colors.secondary} /><Text style={styles.artifactName} numberOfLines={2}>{name ?? file.path}</Text>
    <ChevronRight size={16} color={colors.secondary} />
  </Pressable>;
}

function UserMessage({ onArtifact }: Pick<Props, "onArtifact">) {
  return (
    <MessagePrimitive.Root style={styles.userBubble}>
      <MessagePrimitive.Content
        renderText={({ part }) => <Text selectable style={styles.messageText}>{part.text}</Text>}
        renderImage={({ part }) => <MessageImage uri={part.image} />}
        renderFile={({ part }) => {
          const projectId = part.providerMetadata?.lyra?.projectId;
          return part.sourceType === "id" ? <FileLink file={{ path: part.data, projectId: typeof projectId === "string" ? projectId : undefined }}
            name={part.filename} onOpen={onArtifact} /> : <Text style={styles.detail}>{part.filename ?? "文件"}</Text>;
        }}
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

function ToolCard({ name, run, result, failed, args, active, onArtifact }: { name: string; run?: ToolRun; result?: unknown; failed?: boolean;
  args: unknown; active: boolean; onArtifact: Props["onArtifact"] }) {
  const [expanded, setExpanded] = useState(false);
  const payload = result !== null && typeof result === "object" ? result : undefined;
  const stopped = payload && "cancelled" in payload && payload.cancelled === true;
  const state = run?.state === "cancelled" ? "cancelled" : failed || run?.state === "error" ? "error"
    : run?.state === "done" || (result !== undefined && !stopped) ? "done" : stopped || !active ? "cancelled" : run?.state === "running" ? "running" : "queued";
  const statusText = { queued: "排队中", running: "执行中", done: "已完成", error: "失败", cancelled: "已停止" }[state];
  const output = typeof result === "string" ? result : payload && "text" in payload ? String(payload.text ?? "") : run?.output ?? "";
  const artifacts = toolArtifacts(payload);
  const primaryArtifact = artifacts.length > 0 && ["office_create", "office_edit", "archive_create", "artifact_show"].includes(name);
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
        {state === "running" ? <ActivityIndicator size="small" color={colors.secondary} /> : null}
        {state === "error" ? <TriangleAlert size={16} color={colors.error} /> : null}
        {state === "done" ? <Check size={14} color={colors.secondary} /> : null}
        <Text style={[styles.toolStatus, state === "error" && styles.error]}>{statusText}</Text>
        <ChevronDown size={15} color={colors.secondary} style={expanded ? styles.up : undefined} />
      </Pressable>
      {run?.output && state === "running" ? <Text accessibilityLiveRegion="polite" style={styles.progress}>{run.output}</Text> : null}
      {primaryArtifact ? artifacts.slice(0, 3).map((file) => <FileLink key={file.path} file={file} onOpen={onArtifact} />) : null}
      {expanded ? (
        <View style={styles.payload}>
          {args && typeof args === "object" && Object.keys(args).length ? <Text selectable style={styles.code}>{JSON.stringify(args, null, 2).slice(0, 4200)}</Text> : null}
          {output ? <Text selectable style={[styles.code, state === "error" && styles.error]}>{output}</Text> : null}
          {images.map((uri, index) => <MessageImage key={index} uri={uri} />)}
          {!primaryArtifact ? artifacts.map((file) => <FileLink key={file.path} file={file} onOpen={onArtifact} />) : null}
          {run?.duration !== undefined ? <Text style={styles.detail}>用时 {run.duration < 1000 ? `${Math.round(run.duration)} ms` : `${(run.duration / 1000).toFixed(1)} s`}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function AssistantMessage({ runs, thinking, active, onArtifact, onContinue, canReload }: { runs: Record<string, ToolRun>; thinking: boolean;
  active: boolean; onArtifact: Props["onArtifact"]; onContinue: Props["onContinue"]; canReload: boolean }) {
  const last = useAuiState((state) => state.message.isLast);
  const hasText = useAuiState((state) => state.message.parts.some((part) => part.type === "text" && part.text.trim()));
  const reason = useAuiState((state) => state.message.status?.type === "incomplete" ? state.message.status.reason : undefined);
  return (
    <MessagePrimitive.Root style={styles.reply}>
      <MessagePrimitive.Content
        renderText={({ part }) => <MarkdownText text={part.text} />}
        renderReasoning={({ part }) => <Reasoning text={part.text} active={thinking} />}
        renderToolCall={({ part }) => (
          <ToolCard name={part.toolName} args={part.args} run={runs[part.toolCallId]} result={part.result} failed={part.isError} active={active} onArtifact={onArtifact} />
        )}
      />
      <ErrorPrimitive.Root><ErrorPrimitive.Message style={styles.error} /></ErrorPrimitive.Root>
      {reason === "cancelled" ? <Text style={styles.detail}>已停止</Text> : null}
      {reason === "length" ? <Text style={styles.detail}>已达到模型输出上限</Text> : null}
      {!active && (hasText || (last && canReload)) ? (
        <View style={styles.messageActions}>
          {hasText ? <ActionBarPrimitive.Copy copyToClipboard={copyText} accessibilityLabel="复制回复" style={styles.messageAction}>
            {({ isCopied }) => isCopied ? <Check size={16} color={colors.secondary} /> : <Copy size={16} color={colors.secondary} />}
          </ActionBarPrimitive.Copy> : null}
          {last && canReload ? <ActionBarPrimitive.Reload accessibilityLabel={reason ? "重试" : "重新生成"} style={styles.messageAction}>
            <RotateCcw size={16} color={colors.secondary} />{reason ? <Text style={styles.detail}>重试</Text> : null}
          </ActionBarPrimitive.Reload> : null}
          {last && canReload && hasText && (reason === "length" || reason === "error") ? (
            <Pressable accessibilityRole="button" onPress={onContinue} style={styles.messageAction}><Text style={styles.detail}>继续回答</Text></Pressable>
          ) : null}
        </View>
      ) : null}
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

const phaseLabels: Record<AgentPhase, string> = { preparing: "正在准备附件", waiting: "等待模型响应", thinking: "思考中", tool: "正在处理工具调用",
  writing: "正在生成回复", compacting: "正在压缩对话上下文" };

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
        {({ message }) => message.role === "user" ? <UserMessage onArtifact={props.onArtifact} /> :
          <AssistantMessage runs={props.toolRuns} active={props.composer.running && message.status?.type === "running"}
            canReload={props.canSend && !props.composer.running} onArtifact={props.onArtifact} onContinue={props.onContinue}
            thinking={props.composer.running && props.phase === "thinking" && message.status?.type === "running"} />}
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
  artifact: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 42, borderRadius: 8, paddingHorizontal: 9, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  artifactName: { flex: 1, color: colors.text, fontSize: 14 },
  messageActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  messageAction: { minWidth: 40, minHeight: 38, justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 5 },
  image: { width: 232, height: 157, maxWidth: "100%", backgroundColor: colors.raised, borderRadius: 10 },
  reply: { alignSelf: "stretch", gap: 4 },
  eventHeader: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 8 },
  pressed: { backgroundColor: colors.tint },
  eventCaption: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  eventTitle: { color: colors.secondary, fontSize: 14, flex: 1 },
  toolName: { color: colors.text, fontSize: 14 },
  eventArgument: { color: colors.secondary, fontSize: 13, flex: 1 },
  toolStatus: { color: colors.secondary, fontSize: 12 },
  payload: { paddingLeft: 32, paddingRight: 8, paddingVertical: 6, gap: 6 },
  detail: { color: colors.secondary, fontSize: 13, lineHeight: 19 },
  code: { padding: 8, backgroundColor: colors.raised, color: colors.text, fontFamily: "monospace", fontSize: 12, lineHeight: 18, borderRadius: 7 },
  progress: { marginLeft: 36, marginBottom: 8, color: colors.secondary, fontSize: 13 },
  up: { transform: [{ rotate: "180deg" }] },
  activity: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 28 },
  error: { color: colors.error, lineHeight: 21 },
  threadError: { marginHorizontal: 18, marginBottom: 4, color: colors.error, fontSize: 14 },
});
