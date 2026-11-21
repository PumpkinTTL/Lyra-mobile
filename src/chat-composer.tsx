import { useEffect, useRef, useState } from "react";
import { AttachmentPrimitive, ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react-native";
import { ArrowUp, ChevronDown, File, MessageSquarePlus, Paperclip, X } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { pickAttachments, workspaceSupported } from "./device-workspace";
import { safeModelError } from "./model-catalog";
import { colors } from "./theme";

export type ComposerProps = {
  editable: boolean;
  running: boolean;
  modelLabel: string;
  projectId: string;
  onModels(): void;
  onSteer(text: string): boolean;
};

export function ChatComposer(props: ComposerProps) {
  const aui = useAui();
  const attachmentCount = useAuiState((state) => state.composer.attachments.length);
  const empty = useAuiState((state) => state.composer.isEmpty);
  const text = useAuiState((state) => state.composer.text);
  const picking = useRef(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [steerNotice, setSteerNotice] = useState(false);
  const blocked = props.running || !props.editable;
  useEffect(() => { if (!props.running) setSteerNotice(false); }, [props.running]);

  async function addAttachment() {
    if (blocked || picking.current) return;
    picking.current = true;
    setAttachmentError("");
    try {
      const files = await pickAttachments(props.projectId);
      if (!files) return;
      if (aui.composer.getState().attachments.length + files.length > 6) throw new Error("一条消息最多添加 6 个附件。");
      for (const { name, path, mime, size } of files) {
        await aui.composer.addAttachment({ id: path, name, type: "file", contentType: mime,
          content: [{ type: "file", filename: name, data: path, mimeType: mime, sourceType: "id", providerMetadata: { lyra: { size } } }],
        });
      }
    } catch (error) {
      setAttachmentError(safeModelError(error));
    } finally {
      picking.current = false;
    }
  }

  return (
    <ComposerPrimitive.Root style={styles.composer}>
      {attachmentCount ? (
        <View style={styles.attachments}>
          <ComposerPrimitive.Attachments>
            {({ attachment }) => (
              <AttachmentPrimitive.Root style={styles.attachment}>
                <File size={14} color={colors.secondary} />
                <AttachmentPrimitive.Name numberOfLines={1} style={styles.attachmentName} />
                <AttachmentPrimitive.Remove accessibilityLabel={"移除附件 " + attachment.name} hitSlop={8} style={styles.remove}>
                  <X size={15} color={colors.secondary} />
                </AttachmentPrimitive.Remove>
              </AttachmentPrimitive.Root>
            )}
          </ComposerPrimitive.Attachments>
        </View>
      ) : null}
      {attachmentError ? <Text accessibilityRole="alert" style={styles.error}>{attachmentError}</Text> : null}
      {props.running && steerNotice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>已排入当前任务</Text> : null}
      <ComposerPrimitive.Input accessibilityLabel="消息" placeholder={props.running ? "补充当前任务" : props.editable ? "给 Lyra 发消息" : "选择模型后开始对话"}
        placeholderTextColor={colors.secondary} editable={props.editable} multiline style={styles.input} />
      <View style={styles.toolbar}>
        <ComposerPrimitive.AddAttachment accessibilityLabel="添加附件" disabled={blocked || !workspaceSupported()} onPress={() => { void addAttachment(); }}
          style={({ pressed }) => [styles.icon, pressed && styles.pressed, blocked && styles.dim]}>
          <Paperclip size={20} color={colors.text} />
        </ComposerPrimitive.AddAttachment>
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" accessibilityLabel="选择模型" disabled={props.running} onPress={props.onModels}
            style={({ pressed }) => [styles.model, pressed && styles.pressed]}>
            <Text style={styles.modelLabel} numberOfLines={1}>{props.modelLabel}</Text>
            <ChevronDown size={14} color={colors.secondary} />
          </Pressable>
          {props.running ? (
            <>
              {text.trim() ? <Pressable accessibilityRole="button" accessibilityLabel="补充当前任务" style={styles.icon} onPress={() => {
                if (props.onSteer(text)) { aui.composer.setText(""); setSteerNotice(true); }
              }}><MessageSquarePlus size={19} color={colors.text} /></Pressable> : null}
              <ComposerPrimitive.Cancel accessibilityLabel="停止生成" hitSlop={5} style={styles.send}>
                <View style={styles.stop} />
              </ComposerPrimitive.Cancel>
            </>
          ) : (
            <ComposerPrimitive.Send accessibilityLabel="发送消息" hitSlop={5} disabled={blocked || empty}
              style={({ pressed }) => [styles.send, (blocked || empty || pressed) && styles.dim]}>
              <ArrowUp size={20} color={colors.accentInk} strokeWidth={2.4} />
            </ComposerPrimitive.Send>
          )}
        </View>
      </View>
    </ComposerPrimitive.Root>
  );
}

const styles = StyleSheet.create({
  composer: {
    padding: 8, gap: 8, borderRadius: 24, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  input: { minHeight: 52, maxHeight: 192, paddingHorizontal: 10, paddingVertical: 4, textAlignVertical: "top", color: colors.text, fontSize: 16, lineHeight: 24 },
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  actions: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  pressed: { backgroundColor: colors.tint },
  model: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, paddingHorizontal: 10, borderRadius: 8 },
  modelLabel: { flexShrink: 1, fontSize: 14, fontWeight: "500", color: colors.text },
  send: { alignItems: "center", justifyContent: "center", height: 36, width: 36, borderRadius: 18, backgroundColor: colors.accent },
  stop: { width: 12, height: 12, borderRadius: 2, backgroundColor: colors.accentInk },
  dim: { opacity: 0.5 },
  attachments: { flexDirection: "row", flexWrap: "wrap", gap: 5, paddingHorizontal: 4, paddingTop: 2 },
  attachment: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.tint, borderRadius: 8, paddingLeft: 8, minHeight: 34, maxWidth: "100%" },
  attachmentName: { color: colors.text, fontSize: 13, flexShrink: 1 },
  remove: { width: 32, height: 34, alignItems: "center", justifyContent: "center" },
  error: { paddingHorizontal: 10, color: colors.error, fontSize: 14 },
  notice: { paddingHorizontal: 10, color: colors.secondary, fontSize: 12 },
});
