import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Image, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { ActionBarPrimitive, ErrorPrimitive, MessagePrimitive, ThreadPrimitive, groupPartByType, useAuiState } from "@assistant-ui/react-native";
import { Activity, ArrowDown, Brain, Check, ChevronDown, ChevronRight, Copy, RotateCcw, Settings2, Terminal, TriangleAlert } from "lucide-react-native";
import { useMarkdown } from "react-native-marked";
import { ChatComposer, type ComposerProps } from "./chat-composer";
import { toolArtifacts, turnArtifacts, type AgentPhase, type PartTiming, type ToolRun } from "./chat-messages";
import { copyText, type WorkspaceArtifact } from "./device-workspace";
import { toolLabels } from "./workspace-tools";
import { colors } from "./theme";
import { FileIcon } from "./file-icon";

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

function FileLink({ file, name, mime, onOpen }: { file: WorkspaceArtifact; name?: string; mime?: string; onOpen(file: WorkspaceArtifact): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={"预览文件 " + (name ?? file.path)}
    onPress={() => onOpen(file)} style={({ pressed }) => [styles.artifact, pressed && styles.pressed]}>
    <FileIcon name={name ?? file.path} mime={mime} /><Text style={styles.artifactName} numberOfLines={2}>{name ?? file.path}</Text>
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
            name={part.filename} mime={part.mimeType} onOpen={onArtifact} /> : <View style={styles.artifact}><FileIcon name={part.filename ?? ""} mime={part.mimeType} /><Text style={styles.detail}>{part.filename ?? "文件"}</Text></View>;
        }}
      />
    </MessagePrimitive.Root>
  );
}

const groupWork = groupPartByType({ reasoning: ["group-work"], "tool-call": ["group-work"] });

function elapsed(timing?: PartTiming, fallback?: number) {
  const duration = timing?.completedAt !== undefined ? timing.completedAt - timing.startedAt : fallback;
  return duration === undefined ? undefined : `${Math.max(0.1, duration / 1000).toFixed(duration < 10_000 ? 1 : 0)} 秒`;
}

// Native Elements uses an opacity shimmer and a non-interaction animation.
function ShimmerLabel({ children, motion, style }: { children: string; motion: boolean; style?: StyleProp<TextStyle> }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    opacity.setValue(1);
    if (!motion) return;
    const loop = Animated.loop(Animated.sequence([0.42, 1].map((toValue) => Animated.timing(opacity, {
      toValue, duration: 680, useNativeDriver: true, isInteraction: false,
    }))));
    loop.start();
    return () => loop.stop();
  }, [motion, opacity]);
  return <Animated.Text style={[style, { opacity }]}>{children}</Animated.Text>;
}

function useMotion() {
  const [motion, setMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (reduced) => { changed = true; setMotion(!reduced); });
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => { if (mounted && !changed) setMotion(!reduced); }, () => {});
    return () => { mounted = false; subscription.remove(); };
  }, []);
  return motion;
}

function WorkGroup({ indices, timing, runs, motion, children }: { indices: readonly number[]; timing?: PartTiming;
  runs: Record<string, ToolRun>; motion: boolean; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const parts = useAuiState((state) => state.message.parts);
  const group = indices.map((index) => parts[index]);
  const tool = [...group].reverse().find((part) => part?.type === "tool-call" && runs[part.toolCallId]?.state === "running");
  const thinking = group.some((part) => part?.type === "reasoning" && part.status.type === "running");
  const queued = group.some((part) => part?.type === "tool-call" && part.status.type === "running" && part.result === undefined && !runs[part.toolCallId]);
  const progress = tool?.type === "tool-call" ? runs[tool.toolCallId]?.output : undefined;
  const duration = elapsed(timing);
  const label = tool?.type === "tool-call" ? `${toolLabels[tool.toolName] ?? tool.toolName} · 执行中`
    : thinking ? "思考中" : queued ? "准备工具调用" : duration ? `已处理 ${duration}` : "处理过程";
  return (
    <View style={styles.workGroup}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => [styles.eventHeader, pressed && styles.pressed]}>
        {tool ? <Terminal size={16} color={colors.secondary} /> : <Brain size={16} color={colors.secondary} />}
        <ShimmerLabel style={styles.eventTitle} motion={motion && (!!tool || thinking || queued)}>{label}</ShimmerLabel>
        <ChevronDown size={17} color={colors.secondary} style={expanded ? styles.up : undefined} />
      </Pressable>
      {progress && !expanded ? <Text numberOfLines={1} style={styles.progress}>{progress}</Text> : null}
      {expanded ? <View style={styles.groupContent}>{children}</View> : null}
    </View>
  );
}

function ToolCard({ name, run, result, failed, args, active, timing, motion, onArtifact }: { name: string; run?: ToolRun; result?: unknown; failed?: boolean;
  args: unknown; active: boolean; timing?: PartTiming; motion: boolean; onArtifact: Props["onArtifact"] }) {
  const [expanded, setExpanded] = useState(false);
  const payload = result !== null && typeof result === "object" ? result : undefined;
  const stopped = payload && "cancelled" in payload && payload.cancelled === true;
  const state = run?.state === "cancelled" ? "cancelled" : failed || run?.state === "error" ? "error"
    : run?.state === "done" || (result !== undefined && !stopped) ? "done" : stopped || !active ? "cancelled" : run?.state === "running" ? "running" : "queued";
  const statusText = { queued: "排队中", running: "执行中", done: "已完成", error: "失败", cancelled: "已停止" }[state];
  const output = typeof result === "string" ? result : payload && "text" in payload ? String(payload.text ?? "") : run?.output ?? "";
  const artifacts = toolArtifacts(payload);
  const duration = elapsed(timing, run?.duration);
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
        {state === "error" ? <TriangleAlert size={16} color={colors.error} /> : null}
        {state === "done" ? <Check size={14} color={colors.secondary} /> : null}
        <ShimmerLabel style={[styles.toolStatus, state === "error" && styles.error]} motion={motion && state === "running"}>{duration ? `${statusText} · ${duration}` : statusText}</ShimmerLabel>
        <ChevronDown size={15} color={colors.secondary} style={expanded ? styles.up : undefined} />
      </Pressable>
      {run?.output && state === "running" ? <Text accessibilityLiveRegion="polite" style={styles.progress}>{run.output}</Text> : null}
      {expanded ? (
        <View style={styles.payload}>
          {args && typeof args === "object" && Object.keys(args).length ? <Text selectable style={styles.code}>{JSON.stringify(args, null, 2).slice(0, 4200)}</Text> : null}
          {output ? <Text selectable style={[styles.code, state === "error" && styles.error]}>{output}</Text> : null}
          {images.map((uri, index) => <MessageImage key={index} uri={uri} />)}
          {artifacts.map((file) => <FileLink key={`${file.projectId ?? ""}:${file.path}`} file={file} onOpen={onArtifact} />)}
        </View>
      ) : null}
    </View>
  );
}

function AssistantMessage({ runs, motion, active, onArtifact, onContinue, canReload }: { runs: Record<string, ToolRun>; motion: boolean;
  active: boolean; onArtifact: Props["onArtifact"]; onContinue: Props["onContinue"]; canReload: boolean }) {
  const last = useAuiState((state) => state.message.isLast);
  const hasText = useAuiState((state) => state.message.parts.some((part) => part.type === "text" && part.text.trim()));
  const reason = useAuiState((state) => state.message.status?.type === "incomplete" ? state.message.status.reason : undefined);
  const parts = useAuiState((state) => state.message.parts);
  const artifacts = active ? [] : turnArtifacts(parts);
  return (
    <MessagePrimitive.Root style={styles.reply}>
      <MessagePrimitive.GroupedParts groupBy={groupWork} indicator="never">
        {({ part, children }) => {
          switch (part.type) {
            case "group-work": return <WorkGroup indices={part.indices} timing={part.timing} runs={runs} motion={motion}>{children}</WorkGroup>;
            case "text": return <MarkdownText text={part.text} />;
            case "reasoning": return <View style={styles.payload}><Text style={styles.detail}>{elapsed(part.timing) ? `思考 · ${elapsed(part.timing)}` : "思考"}</Text><MarkdownText text={part.text} /></View>;
            case "tool-call": return <ToolCard name={part.toolName} args={part.args} run={runs[part.toolCallId]} result={part.result} failed={part.isError}
              active={active} timing={part.timing} motion={motion} onArtifact={onArtifact} />;
            default: return null;
          }
        }}
      </MessagePrimitive.GroupedParts>
      {artifacts.length ? <View style={styles.artifacts}><Text style={styles.artifactHeading}>产物 · {artifacts.length}</Text>
        {artifacts.map((file) => <FileLink key={`${file.projectId ?? ""}:${file.path}`} file={file} onOpen={onArtifact} />)}
      </View> : null}
      <ErrorPrimitive.Root><ErrorPrimitive.Message style={styles.error} /></ErrorPrimitive.Root>
      {reason === "cancelled" ? <Text style={styles.detail}>已停止</Text> : null}
      {reason === "length" ? <Text style={styles.detail}>供应商报告已达到输出上限</Text> : null}
      {hasText || (last && canReload && !active) ? (
        <View style={styles.messageActions}>
          {hasText ? <ActionBarPrimitive.Copy copyToClipboard={copyText} accessibilityLabel="复制回复" style={styles.messageAction}>
            {({ isCopied }) => isCopied ? <Check size={16} color={colors.secondary} /> : <Copy size={16} color={colors.secondary} />}
          </ActionBarPrimitive.Copy> : null}
          {last && canReload && !active ? <ActionBarPrimitive.Reload accessibilityLabel={reason ? "重试" : "重新生成"} style={styles.messageAction}>
            <RotateCcw size={16} color={colors.secondary} />{reason ? <Text style={styles.detail}>重试</Text> : null}
          </ActionBarPrimitive.Reload> : null}
          {last && canReload && !active && (reason === "length" || (hasText && reason === "error")) ? (
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
  const [nearBottom, setNearBottom] = useState(true);
  const list = useRef<ComponentRef<typeof ThreadPrimitive.MessagesFlatList>>(null);
  const motion = useMotion();
  const showActivity = props.composer.running && props.phase !== "writing" && props.phase !== "thinking" && props.phase !== "tool";
  return (
    <ThreadPrimitive.Root style={styles.root}>
      <ThreadPrimitive.MessagesFlatList ref={list} style={[styles.list, { marginBottom: footerHeight }]} contentContainerStyle={styles.messages}
        ListEmptyComponent={<Welcome {...props} />} autoScroll scrollToBottomOnRunStart keyboardShouldPersistTaps="handled"
        onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
          const atEnd = contentSize.height - layoutMeasurement.height - contentOffset.y <= 72;
          setNearBottom((previous) => previous === atEnd ? previous : atEnd);
        }}
        ListFooterComponent={showActivity ? (
          <View style={styles.activity} accessibilityLiveRegion="polite">
            <Activity size={15} color={colors.accent} />
            <ShimmerLabel style={styles.detail} motion={motion}>{phaseLabels[props.phase]}</ShimmerLabel>
          </View>
        ) : undefined}>
        {({ message }) => message.role === "user" ? <UserMessage onArtifact={props.onArtifact} /> :
          <AssistantMessage runs={props.toolRuns} motion={motion} active={props.composer.running && message.status?.type === "running"}
            canReload={props.composer.canSubmit && !props.composer.running} onArtifact={props.onArtifact} onContinue={props.onContinue} />}
      </ThreadPrimitive.MessagesFlatList>
      {!nearBottom ? <Pressable accessibilityRole="button" accessibilityLabel="回到最新消息" onPress={() => list.current?.scrollToEnd({ animated: motion })}
        style={[styles.jump, { bottom: footerHeight + 8 }]}><ArrowDown size={20} color={colors.text} /></Pressable> : null}
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
  messages: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, gap: 22 },
  floatingComposer: { position: "absolute", bottom: 0, left: 0, right: 0, paddingTop: 12, paddingBottom: 8, paddingHorizontal: 16, backgroundColor: colors.background },
  jump: { position: "absolute", alignSelf: "center", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  welcome: { flex: 1, justifyContent: "center", alignItems: "center", paddingBottom: 24, paddingHorizontal: 16, gap: 16 },
  title: { color: colors.text, fontSize: 24, fontWeight: "500", textAlign: "center", letterSpacing: -0.3 },
  connect: { minHeight: 44, borderRadius: 20, paddingHorizontal: 15, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.accent },
  connectText: { color: colors.accentInk, fontSize: 14, fontWeight: "500" },
  userBubble: { alignSelf: "flex-end", maxWidth: "85%", backgroundColor: colors.raised, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 14, gap: 7 },
  messageText: { color: colors.text, fontSize: 16, lineHeight: 24 },
  artifact: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 42, borderRadius: 8, paddingHorizontal: 9, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  artifactName: { flex: 1, color: colors.text, fontSize: 14 },
  artifacts: { marginTop: 6, gap: 6 },
  artifactHeading: { color: colors.secondary, fontWeight: "600", fontSize: 13 },
  messageActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  messageAction: { minWidth: 40, minHeight: 38, justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 5 },
  image: { width: 232, height: 157, maxWidth: "100%", backgroundColor: colors.raised, borderRadius: 10 },
  reply: { alignSelf: "stretch", gap: 4 },
  workGroup: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 10 },
  groupContent: { paddingBottom: 8 },
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
