import { useEffect, useRef, useState } from "react";
import { Alert, Animated, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { Ellipsis, MessageSquare, Plus, Settings2, X } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Conversation } from "./conversations";
import { safeModelError } from "./model-catalog";
import { colors } from "./theme";

type Props = {
  currentId?: string;
  conversations: Conversation[];
  disabled: boolean;
  onClose: () => void;
  onSettings: () => void;
  onNew: () => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

export function ConversationDrawer(props: Props) {
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(340, width * 0.86);
  const translation = useRef(new Animated.Value(-panelWidth)).current;
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const motion = Animated.timing(translation, { toValue: 0, duration: 185, useNativeDriver: true });
    motion.start();
    return () => motion.stop();
  }, [translation]);

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
      { text: "删除", style: "destructive", onPress: () => {
        Alert.alert("删除这段对话？", "此操作会清除手机上的该会话。", [
          { text: "取消", style: "cancel" },
          { text: "删除", style: "destructive", onPress: () => { void handle(() => props.onDelete(item.id)); } },
        ]);
      } },
    ]);
  }

  return (
    <Modal transparent animationType="none" onRequestClose={props.onClose}>
      <View style={styles.overlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭侧栏" onPress={props.onClose} style={StyleSheet.absoluteFill} />
        <Animated.View style={[styles.panel, { width: panelWidth, transform: [{ translateX: translation }] }]}>
          <SafeAreaView style={styles.safe}>
            <View style={styles.header}>
              <Text style={styles.title}>对话</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="关闭对话列表" onPress={props.onClose} style={styles.icon}>
                <X size={21} color={colors.text} />
              </Pressable>
            </View>
            <Pressable accessibilityRole="button" disabled={props.disabled} onPress={() => { void handle(props.onNew, props.onClose); }} style={[styles.newChat, props.disabled && styles.disabled]}>
              <Plus size={20} color={colors.accentInk} /><Text style={styles.newLabel}>新对话</Text>
            </Pressable>
            <FlatList data={props.conversations} keyExtractor={(item) => item.id} style={styles.list} contentContainerStyle={styles.items}
              keyboardShouldPersistTaps="handled" ListEmptyComponent={<Text style={styles.empty}>还没有保存的对话。</Text>}
              renderItem={({ item }) => editing === item.id ? (
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
              ) : (
                <View style={[styles.row, item.id === props.currentId && styles.selected]}>
                  <Pressable accessibilityRole="button" accessibilityState={{ selected: item.id === props.currentId, disabled: props.disabled }}
                    disabled={props.disabled} onPress={() => { void handle(() => props.onOpen(item.id), props.onClose); }} style={styles.thread}>
                    <MessageSquare size={17} color={colors.secondary} />
                    <Text style={styles.threadLabel} numberOfLines={1}>{item.title || "新对话"}</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel={(item.title || "新对话") + "选项"} onPress={() => actions(item)} disabled={props.disabled} style={styles.icon}>
                    <Ellipsis size={19} color={colors.secondary} />
                  </Pressable>
                </View>
              )}
            />
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            <Pressable accessibilityRole="button" onPress={props.onSettings} disabled={props.disabled} style={[styles.footer, props.disabled && styles.disabled]}>
              <Settings2 size={20} color={colors.accent} /><Text style={styles.footerLabel}>设置</Text>
            </Pressable>
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, flexDirection: "row", backgroundColor: colors.overlay },
  panel: { backgroundColor: colors.surface },
  safe: { flex: 1, paddingHorizontal: 12 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 7, marginVertical: 9 },
  title: { color: colors.text, fontSize: 23, fontWeight: "700" },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  newChat: { backgroundColor: colors.accent, borderRadius: 13, minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, marginBottom: 10 },
  newLabel: { color: colors.accentInk, fontSize: 15, fontWeight: "700" },
  list: { flex: 1 },
  items: { gap: 4 },
  row: { flexDirection: "row", alignItems: "center", borderRadius: 12, minHeight: 46 },
  selected: { backgroundColor: colors.tint },
  thread: { flex: 1, flexDirection: "row", alignItems: "center", gap: 11, paddingLeft: 12, minHeight: 46 },
  threadLabel: { color: colors.text, fontSize: 15, flex: 1 },
  rename: { flexDirection: "row", alignItems: "center", gap: 1 },
  input: { flex: 1, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 10, minHeight: 44, paddingHorizontal: 9 },
  smallButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  link: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  empty: { color: colors.secondary, fontSize: 14, margin: 11 },
  footer: { borderTopWidth: 1, borderColor: colors.border, minHeight: 54, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 11 },
  footerLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  error: { color: colors.error, margin: 8, fontSize: 13 },
  disabled: { opacity: 0.45 },
});
