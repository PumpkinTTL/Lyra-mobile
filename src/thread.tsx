import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Animated, Image, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { ActionBarPrimitive, ErrorPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react-native";
import { ArrowDown, Check, ChevronDown, ChevronUp, Copy, RotateCcw, Settings2 } from "lucide-react-native";
import { useMarkdown } from "react-native-marked";
import { ChatComposer, type ComposerProps } from "./chat-composer";
import { toolArtifacts, turnArtifacts, type AgentPhase, type PartTiming, type ToolRun } from "./chat-messages";
import { copyText, type WorkspaceArtifact } from "./device-workspace";
import { toolLabels } from "./workspace-tools";
import { colors, useMotion } from "./theme";
import { FileIcon } from "./file-icon";

type Props = {
  ready: boolean;
  canSend: boolean;
  error: string;
  phase: AgentPhase;
  toolRuns: Record<string, ToolRun>;
  processing?: PartTiming;
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
  const displayName = name ?? file.path.split("/").at(-1) ?? file.path;
  return <Pressable accessibilityRole="button" accessibilityLabel={"预览文件 " + (name ?? file.path)}
    onPress={() => onOpen(file)} style={({ pressed }) => [styles.artifact, pressed && styles.fade]}>
    <FileIcon name={displayName} mime={mime} /><Text style={styles.artifactName} numberOfLines={2}>{displayName}</Text>
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

function StatusLine({ label, timing, motion, active, expanded, onPress }: { label: string; timing?: PartTiming; motion: boolean;
  active: boolean; expanded?: boolean; onPress?: () => void }) {
  const [now, setNow] = useState(Date.now);
  const startedAt = timing?.startedAt;
  useEffect(() => {
    if (!active || startedAt === undefined) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [active, startedAt]);
  const duration = active && startedAt !== undefined ? `${Math.floor(Math.max(0, now - startedAt) / 1000)} 秒` : elapsed(timing);
  const children = <>
    <ShimmerLabel style={styles.summaryLabel} motion={motion && active}>{label}</ShimmerLabel>
    {duration ? <Text style={styles.duration}>· {duration}</Text> : null}
    {onPress ? <Disclosure expanded={expanded} /> : null}
  </>;
  return onPress ? <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={onPress}
    style={({ pressed }) => [styles.summary, pressed && styles.fade]}>{children}</Pressable> : <View style={styles.summary}>{children}</View>;
}

function Disclosure({ expanded }: { expanded?: boolean }) {
  return expanded ? <ChevronUp size={14} color={colors.secondary} /> : <ChevronDown size={14} color={colors.secondary} />;
}

function ToolCard({ name, run, result, failed, args, active, timing, onArtifact }: { name: string; run?: ToolRun; result?: unknown; failed?: boolean;
  args: unknown; active: boolean; timing?: PartTiming; onArtifact: Props["onArtifact"] }) {
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
        style={({ pressed }) => [styles.eventHeader, pressed && styles.fade]}>
        <View style={styles.eventCaption}>
          <Text style={styles.toolName} numberOfLines={1}>{toolLabels[name] ?? name}</Text>
          {argLabel ? <Text style={styles.eventArgument} numberOfLines={1} ellipsizeMode="middle">{argLabel}</Text> : null}
        </View>
        <Text style={[styles.toolStatus, state === "error" && styles.error]}>{duration ? `${statusText} · ${duration}` : statusText}</Text>
        <Disclosure expanded={expanded} />
      </Pressable>
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

function AssistantMessage({ runs, motion, active, phase, onArtifact, onContinue, canReload }: { runs: Record<string, ToolRun>; motion: boolean;
  active: boolean; phase: AgentPhase; onArtifact: Props["onArtifact"]; onContinue: Props["onContinue"]; canReload: boolean }) {
  const last = useAuiState((state) => state.message.isLast);
  const hasText = useAuiState((state) => state.message.parts.some((part) => part.type === "text" && part.text.trim()));
  const reason = useAuiState((state) => state.message.status?.type === "incomplete" ? state.message.status.reason : undefined);
  const parts = useAuiState((state) => state.message.parts);
  const timing = useAuiState((state) => state.message.metadata.custom.lyraTurn) as PartTiming | undefined;
  const [expanded, setExpanded] = useState(false);
  const steps = parts.filter((part) => part.type === "reasoning" || part.type === "tool-call");
  const tool = active && phase === "tool" ? steps.find((part) => part.type === "tool-call" && runs[part.toolCallId]?.state === "running") : undefined;
  const label = tool?.type === "tool-call" ? (toolLabels[tool.toolName] ?? tool.toolName)
    : active ? phaseLabels[phase] : reason === "cancelled" ? "已停止" : reason === "error" ? "已中断" : timing ? "本轮耗时" : "处理记录";
  const artifacts = active ? [] : turnArtifacts(parts);
  return (
    <MessagePrimitive.Root style={styles.reply}>
      {active || timing || steps.length ? <StatusLine label={label} timing={timing} active={active} motion={motion}
        expanded={expanded} onPress={steps.length ? () => setExpanded(!expanded) : undefined} /> : null}
      {expanded ? <View style={styles.groupContent}>
        {steps.map((part, index) => part.type === "reasoning" ? <View key={part.id ?? index} style={styles.reasoning}>
          <Text style={styles.detail}>{part.status.type === "running" ? "思考中" : "思考"}{elapsed(part.timing) ? ` · ${elapsed(part.timing)}` : ""}</Text>
          <MarkdownText text={part.text} />
        </View> : <ToolCard key={part.toolCallId} name={part.toolName} args={part.args} run={runs[part.toolCallId]} result={part.result} failed={part.isError}
          active={active} timing={part.timing} onArtifact={onArtifact} />)}
      </View> : null}
      <MessagePrimitive.Content renderText={({ part }) => <MarkdownText text={part.text} />} renderImage={({ part }) => <MessageImage uri={part.image} />} />
      {artifacts.length ? <View style={styles.artifacts}><Text style={styles.artifactHeading}>产物 · {artifacts.length}</Text>
        {artifacts.map((file) => <FileLink key={`${file.projectId ?? ""}:${file.path}`} file={file} onOpen={onArtifact} />)}
      </View> : null}
      <ErrorPrimitive.Root><ErrorPrimitive.Message style={styles.error} /></ErrorPrimitive.Root>
      {reason === "cancelled" && !timing && !steps.length ? <Text style={styles.detail}>已停止</Text> : null}
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

const phaseLabels: Record<AgentPhase, string> = { preparing: "准备附件", waiting: "正在处理", thinking: "思考中", tool: "执行工具", writing: "正在回复", compacting: "整理上下文" };

export function Thread(props: Props) {
  const [footerHeight, setFooterHeight] = useState(142);
  const [nearBottom, setNearBottom] = useState(true);
  const list = useRef<ComponentRef<typeof ThreadPrimitive.MessagesFlatList>>(null);
  const motion = useMotion();
  const hasRunningMessage = useAuiState((state) => state.thread.messages.at(-1)?.status?.type === "running");
  const showActivity = props.composer.running && !!props.processing && !hasRunningMessage;
  return (
    <ThreadPrimitive.Root style={styles.root}>
      <ThreadPrimitive.MessagesFlatList ref={list} style={[styles.list, { marginBottom: footerHeight }]} contentContainerStyle={styles.messages}
        ListEmptyComponent={<Welcome {...props} />} autoScroll scrollToBottomOnRunStart keyboardShouldPersistTaps="handled"
        onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
          const atEnd = contentSize.height - layoutMeasurement.height - contentOffset.y <= 72;
          setNearBottom((previous) => previous === atEnd ? previous : atEnd);
        }}
        ListFooterComponent={showActivity ? <StatusLine label={phaseLabels[props.phase]} timing={props.processing} active motion={motion} /> : undefined}>
        {({ message }) => message.role === "user" ? <UserMessage onArtifact={props.onArtifact} /> :
          <AssistantMessage runs={props.toolRuns} motion={motion} phase={props.phase} active={props.composer.running && message.status?.type === "running"}
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
  artifact: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 42 },
  artifactName: { flex: 1, color: colors.text, fontSize: 14 },
  artifacts: { marginTop: 6, gap: 6 },
  artifactHeading: { color: colors.secondary, fontWeight: "600", fontSize: 13 },
  messageActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  messageAction: { minWidth: 40, minHeight: 38, justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 5 },
  image: { width: 232, height: 157, maxWidth: "100%", backgroundColor: colors.raised, borderRadius: 10 },
  reply: { alignSelf: "stretch", gap: 4 },
  summary: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, alignSelf: "flex-start" },
  summaryLabel: { color: colors.secondary, fontSize: 13, fontWeight: "500", flexShrink: 1 },
  duration: { color: colors.secondary, fontSize: 13, fontVariant: ["tabular-nums"] },
  groupContent: { paddingLeft: 12, paddingBottom: 8, gap: 2 },
  reasoning: { paddingVertical: 8, gap: 4 },
  eventHeader: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingVertical: 5 },
  fade: { opacity: 0.56 },
  eventCaption: { flex: 1, minWidth: 0, gap: 2 },
  toolName: { color: colors.text, fontSize: 14, fontWeight: "500" },
  eventArgument: { color: colors.secondary, fontSize: 12 },
  toolStatus: { color: colors.secondary, fontSize: 12, fontVariant: ["tabular-nums"] },
  payload: { paddingLeft: 10, paddingVertical: 6, gap: 6 },
  detail: { color: colors.secondary, fontSize: 13, lineHeight: 19 },
  code: { color: colors.text, fontFamily: "monospace", fontSize: 12, lineHeight: 18 },
  error: { color: colors.error, lineHeight: 21 },
  threadError: { marginHorizontal: 18, marginBottom: 4, color: colors.error, fontSize: 14 },
});
