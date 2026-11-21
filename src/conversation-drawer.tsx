import { useEffect, useMemo, useState } from "react";
import { Alert, Animated, BackHandler, Easing, Pressable, StyleSheet, Text, TextInput, View, useAnimatedValue, useWindowDimensions } from "react-native";
import { ThreadListItemPrimitive, ThreadListPrimitive } from "@assistant-ui/react-native";
import { Ellipsis, FolderOpen, Settings2, SquarePen, X } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Conversation } from "./conversations";
import { safeModelError } from "./model-catalog";
import { colors, useMotion } from "./theme";

type Props = {
  open: boolean;
  currentId?: string;
  runningId: string | null;
  conversations: Conversation[];
  disabled: boolean;
  onClose: () => void;
  onSettings: () => void;
  onWorkspace: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

export function ConversationDrawer(props: Props) {
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(340, width * 0.86);
  const progress = useAnimatedValue(0);
  const translation = useMemo(() => progress.interpolate({ inputRange: [0, 1], outputRange: [-panelWidth, 0] }), [panelWidth, progress]);
  const motion = useMotion();
  const [retained, setRetained] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const byId = useMemo(() => new Map(props.conversations.map((item) => [item.id, item])), [props.conversations]);
  const { open, onClose } = props;

  useEffect(() => {
    if (open) setRetained(true);
    const animation = Animated.timing(progress, { toValue: open ? 1 : 0, duration: motion ? open ? 225 : 170 : 0,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic), useNativeDriver: true, isInteraction: false });
    animation.start(({ finished }) => {
      if (!open && finished) { setRetained(false); setEditing(null); setError(""); }
    });
    return () => animation.stop();
  }, [motion, open, progress]);

  useEffect(() => {
    if (!open) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { onClose(); return true; });
    return () => subscription.remove();
  }, [open, onClose]);

  async function handle(action: () => Promise<void>, after?: () => void) {
    setError("");
    try {
      await action();
      after?.();
    } catch (cause) {
      setError(safeModelError(cause));
    }
  }

  function submitTitle() {
    if (!editing || !title.trim() || props.disabled) return;
    void handle(() => props.onRename(editing, title.trim()), () => setEditing(null));
  }

  function actions(item: Conversation) {
    Alert.alert(item.title || "新对话", undefined, [
      { text: "取消", style: "cancel" },
      { text: "重命名", onPress: () => { setTitle(item.title); setEditing(item.id); } },
      ...(props.runningId === item.id ? [] : [{ text: "删除", style: "destructive" as const, onPress: () => {
        Alert.alert("删除这段对话？", "此操作会清除手机上的该会话。", [
          { text: "取消", style: "cancel" },
          { text: "删除", style: "destructive", onPress: () => { void handle(() => props.onDelete(item.id)); } },
        ]);
      } }]),
    ]);
  }

  function renderItem({ threadId }: { threadId: string }) {
    const item = byId.get(threadId);
    if (!item) return <></>;
    if (editing === item.id) return (
      <View style={styles.rename}>
        <TextInput accessibilityLabel="对话名称" style={styles.input} value={title} onChangeText={setTitle}
          placeholder="输入对话名称" placeholderTextColor={colors.secondary} onSubmitEditing={submitTitle} maxLength={80} autoFocus />
        <Pressable accessibilityRole="button" accessibilityLabel="保存对话名称" onPress={submitTitle} disabled={!title.trim() || props.disabled} style={styles.smallButton}>
          <Text style={styles.link}>保存</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="取消重命名" onPress={() => setEditing(null)} style={styles.icon}>
          <X size={17} color={colors.secondary} />
        </Pressable>
      </View>
    );

    const selected = threadId === props.currentId;
    const label = <>
      <ThreadListItemPrimitive.Title fallback="新对话" numberOfLines={1} style={[styles.threadLabel, selected && styles.selectedLabel]} />
      {threadId === props.runningId ? <Text style={styles.running}>工作中</Text> : null}
    </>;
    return (
      <ThreadListItemPrimitive.Root style={[styles.row, selected && styles.selected]}>
        {selected ? (
          <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={props.onClose} style={styles.thread}>{label}</Pressable>
        ) : (
          <ThreadListItemPrimitive.Trigger disabled={props.disabled} style={({ pressed }) => [styles.thread, pressed && styles.selected]}>
            {label}
          </ThreadListItemPrimitive.Trigger>
        )}
        <Pressable accessibilityRole="button" accessibilityLabel={(item.title || "新对话") + "选项"} onPress={() => actions(item)} disabled={props.disabled} style={styles.icon}>
          <Ellipsis size={17} color={colors.secondary} />
        </Pressable>
      </ThreadListItemPrimitive.Root>
    );
  }

  if (!open && !retained) return null;
  return (
      <View pointerEvents={open ? "auto" : "none"} accessibilityViewIsModal={open}
        accessibilityElementsHidden={!open} importantForAccessibility={open ? "auto" : "no-hide-descendants"} style={styles.overlay}>
        <Animated.View pointerEvents="none" style={[styles.backdrop, { opacity: progress }]} />
        <Pressable accessibilityRole="button" accessibilityLabel="关闭侧栏" onPress={props.onClose} style={StyleSheet.absoluteFill} />
        <Animated.View style={[styles.panel, { width: panelWidth, transform: [{ translateX: translation }] }]}>
          <SafeAreaView style={styles.safe}>
            <View style={styles.header}>
              <Text style={styles.title}>对话</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="关闭对话列表" onPress={props.onClose} style={styles.icon}>
                <X size={21} color={colors.text} />
              </Pressable>
            </View>
            <ThreadListPrimitive.Root style={styles.list}>
              <ThreadListPrimitive.New disabled={props.disabled} style={({ pressed }) => [styles.newChat, pressed && styles.selected, props.disabled && styles.disabled]}>
                <SquarePen size={18} color={colors.text} /><Text style={styles.newLabel}>新对话</Text>
              </ThreadListPrimitive.New>
              {props.conversations.length > 0 ? <Text style={styles.section}>最近对话</Text> : null}
              <ThreadListPrimitive.Items renderItem={renderItem} style={styles.list} contentContainerStyle={styles.items}
                initialNumToRender={12} maxToRenderPerBatch={8} windowSize={5}
                keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
                ListEmptyComponent={<Text style={styles.empty}>还没有保存的对话。</Text>} />
            </ThreadListPrimitive.Root>
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            <View style={styles.footer}>
              <Pressable accessibilityRole="button" onPress={props.onWorkspace} disabled={props.disabled}
                style={({ pressed }) => [styles.footerAction, pressed && styles.selected, props.disabled && styles.disabled]}>
                <FolderOpen size={18} color={colors.secondary} /><Text style={styles.footerLabel}>工作区</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={props.onSettings} disabled={props.disabled}
                style={({ pressed }) => [styles.footerAction, pressed && styles.selected, props.disabled && styles.disabled]}>
                <Settings2 size={18} color={colors.secondary} /><Text style={styles.footerLabel}>设置</Text>
              </Pressable>
            </View>
          </SafeAreaView>
        </Animated.View>
      </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, flexDirection: "row", zIndex: 2 },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlay },
  panel: { backgroundColor: colors.surface },
  safe: { flex: 1, paddingHorizontal: 12 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 7, marginVertical: 9 },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  newChat: { borderRadius: 8, minHeight: 44, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 10 },
  newLabel: { color: colors.text, fontSize: 15, fontWeight: "500" },
  section: { color: colors.secondary, fontSize: 12, fontWeight: "500", paddingHorizontal: 12, paddingTop: 13, paddingBottom: 6 },
  list: { flex: 1 },
  items: { paddingBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", borderRadius: 8, minHeight: 44 },
  selected: { backgroundColor: colors.tint },
  thread: { flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 8, paddingHorizontal: 12 },
  threadLabel: { color: colors.text, fontSize: 15, flex: 1 },
  running: { color: colors.secondary, fontSize: 12 },
  selectedLabel: { fontWeight: "600" },
  rename: { flexDirection: "row", alignItems: "center", gap: 1 },
  input: { flex: 1, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 10, minHeight: 44, paddingHorizontal: 9 },
  smallButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  link: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  empty: { color: colors.secondary, fontSize: 14, margin: 11 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, flexDirection: "row", gap: 4, paddingVertical: 4 },
  footerAction: { flex: 1, minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderRadius: 8 },
  footerLabel: { color: colors.text, fontSize: 14, fontWeight: "500" },
  error: { color: colors.error, margin: 8, fontSize: 13 },
  disabled: { opacity: 0.45 },
});
