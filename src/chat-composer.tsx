import { ComposerPrimitive, useAuiState } from "@assistant-ui/react-native";
import { ArrowUp, Brain, ChevronDown, File, FolderOpen, Paperclip, Square, X } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { WorkspaceAttachment } from "./device-workspace";
import { colors } from "./theme";

export type ComposerProps = {
  editable: boolean;
  running: boolean;
  modelLabel: string;
  thinkingLabel: string;
  projectName: string;
  attachments: readonly WorkspaceAttachment[];
  onModels(): void;
  onThinking(): void;
  onWorkspace(): void;
  onPickAttachments(): void;
  onRemoveAttachment(path: string): void;
  onSendAttachments(): void;
};

export function ChatComposer(props: ComposerProps) {
  const text = useAuiState((state) => state.composer.text);
  const blocked = props.running || !props.editable;
  const sendIcon = <ArrowUp size={23} color={colors.accentInk} strokeWidth={2.4} />;
  const pendingOnly = props.attachments.length > 0 && !text.trim();
  return (
    <ComposerPrimitive.Root style={styles.composer}>
      {props.attachments.length ? (
        <View style={styles.attachments}>
          {props.attachments.map((item) => (
            <View key={item.path} style={styles.attachment}>
              <File size={14} color={colors.accent} />
              <Text numberOfLines={1} style={styles.attachmentName}>{item.name}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={"移除附件 " + item.name}
                hitSlop={8} disabled={props.running} onPress={() => props.onRemoveAttachment(item.path)}>
                <X size={16} color={colors.secondary} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <ComposerPrimitive.Input accessibilityLabel="消息" placeholder={props.editable ? "给 Lyra 发消息" : "选择模型后开始对话"}
        placeholderTextColor={colors.secondary} editable={!blocked} multiline style={styles.input} />
      <View style={styles.toolbar}>
        <View style={styles.tools}>
          <Pressable accessibilityRole="button" accessibilityLabel="添加附件" disabled={blocked} onPress={props.onPickAttachments}
            style={[styles.icon, blocked && styles.dim]}><Paperclip size={21} color={colors.text} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={"工作区：" + props.projectName} disabled={props.running}
            onPress={props.onWorkspace} style={styles.icon}><FolderOpen size={21} color={colors.text} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={"思考级别：" + props.thinkingLabel} disabled={blocked}
            onPress={props.onThinking} style={[styles.icon, props.thinkingLabel !== "关闭" && styles.toolActive]}>
            <Brain size={21} color={props.thinkingLabel !== "关闭" ? colors.accent : colors.text} />
          </Pressable>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="选择模型" disabled={props.running} onPress={props.onModels} style={styles.model}>
          <Text style={styles.modelLabel} numberOfLines={1}>{props.modelLabel}</Text>
          <ChevronDown size={14} color={colors.accent} />
        </Pressable>
        {props.running ? (
          <ComposerPrimitive.Cancel accessibilityLabel="停止生成" style={styles.send}>
            <Square size={16} fill={colors.accentInk} color={colors.accentInk} />
          </ComposerPrimitive.Cancel>
        ) : pendingOnly ? (
          <Pressable accessibilityRole="button" accessibilityLabel="发送消息" disabled={blocked}
            onPress={props.onSendAttachments} style={[styles.send, blocked && styles.dim]}>{sendIcon}</Pressable>
        ) : (
          <ComposerPrimitive.Send accessibilityLabel="发送消息" disabled={blocked}
            style={({ pressed }) => [styles.send, (blocked || !text.trim() || pressed) && styles.dim]}>{sendIcon}</ComposerPrimitive.Send>
        )}
      </View>
    </ComposerPrimitive.Root>
  );
}

const styles = StyleSheet.create({
  composer: {
    marginHorizontal: 14, marginTop: 4, marginBottom: 10, padding: 10, borderRadius: 23, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border, elevation: 5, shadowColor: colors.text,
    shadowOpacity: 0.12, shadowRadius: 13, shadowOffset: { width: 0, height: 4 },
  },
  input: { minHeight: 66, maxHeight: 164, paddingHorizontal: 10, paddingVertical: 10, textAlignVertical: "top", color: colors.text, fontSize: 17, lineHeight: 25 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 7 },
  tools: { flexDirection: "row", alignItems: "center", gap: 1 },
  icon: { width: 39, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  toolActive: { backgroundColor: colors.tint },
  model: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: 7, minHeight: 39, borderRadius: 11, backgroundColor: colors.tint },
  modelLabel: { flexShrink: 1, fontSize: 13, fontWeight: "600", color: colors.accent },
  send: { alignItems: "center", justifyContent: "center", height: 45, width: 45, borderRadius: 15, backgroundColor: colors.accent },
  dim: { opacity: 0.46 },
  attachments: { flexDirection: "row", flexWrap: "wrap", gap: 5, paddingHorizontal: 4, paddingTop: 2 },
  attachment: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.tint, borderRadius: 9, paddingHorizontal: 8, minHeight: 34, maxWidth: "100%" },
  attachmentName: { color: colors.text, fontSize: 13, flexShrink: 1 },
});
