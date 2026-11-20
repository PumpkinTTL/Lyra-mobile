import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Check, Download, FlaskConical, Plus, X } from "lucide-react-native";
import { testModelConnection } from "./agent";
import { localId } from "./conversations";
import { fetchProviderModels, normalizeProvider, protocols, providerRef, safeModelError, type ModelRef, type Protocol, type Provider } from "./model-catalog";
import { streamingFetch } from "./model-fetch";
import { colors } from "./theme";

type Props = {
  provider?: Provider;
  onSave: (provider: Provider, selected: ModelRef) => Promise<void>;
  onSaved: (activated: boolean) => void;
  onBusy: (busy: boolean) => void;
};

const supported = Object.keys(protocols) as Protocol[];

export function ProviderEditor({ provider, onSave, onSaved, onBusy }: Props) {
  const [draft, setDraft] = useState<Provider>(() => provider ?? {
    id: localId(), name: "", protocol: "openai", endpoint: "", apiKey: "", models: [],
  });
  const [activeModel, setActiveModel] = useState(provider?.models[0] ?? "");
  const [manualModel, setManualModel] = useState("");
  const [upstream, setUpstream] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(40);
  const [task, setTask] = useState<"list" | "test" | "save" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  function update(field: "name" | "endpoint" | "apiKey", value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setError("");
    setNotice("");
    if (field !== "name") setUpstream([]);
  }

  function changeProtocol(protocol: Protocol) {
    if (protocol === draft.protocol) return;
    setDraft({ ...draft, protocol, endpoint: "" });
    setUpstream([]);
    setError("");
    setNotice("");
  }

  function addModel(value: string) {
    const model = value.trim();
    if (!model) return;
    if (!draft.models.includes(model)) setDraft({ ...draft, models: [...draft.models, model] });
    setActiveModel(model);
    setManualModel("");
    setNotice("");
    setError("");
  }

  function removeModel(model: string) {
    const models = draft.models.filter((item) => item !== model);
    setDraft({ ...draft, models });
    if (activeModel === model) setActiveModel(models[0] ?? "");
    setNotice("");
    setError("");
  }

  async function operate(action: "list" | "test" | "save", activate = false) {
    if (task) return;
    setError("");
    setNotice("");
    const source = { ...draft, endpoint: draft.endpoint.trim() || protocols[draft.protocol].endpoint };
    if (action !== "save" && !source.name.trim()) source.name = protocols[source.protocol].label;
    let verified: Provider;
    try {
      verified = normalizeProvider(source);
    } catch (cause) {
      setError(safeModelError(cause, source.apiKey));
      return;
    }

    setTask(action);
    onBusy(true);
    const abort = new AbortController();
    request.current = abort;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const selected = verified.models.includes(activeModel) ? activeModel : verified.models[0];
    try {
      if (action === "list") {
        timeout = setTimeout(() => { timedOut = true; abort.abort(); }, 25_000);
        const models = await fetchProviderModels(verified, fetch, abort.signal);
        setUpstream(models);
        setLimit(40);
        setQuery("");
        setNotice(models.length ? "已拉取 " + models.length + " 个模型，点选即可添加。" : "供应商没有返回可用模型，可手动添加。");
      } else if (action === "test") {
        if (!selected) throw new Error("请先添加并选中要测试的模型。");
        await testModelConnection({ ...verified, model: selected }, streamingFetch, abort.signal);
        setNotice(selected + " 已成功返回回复。");
      } else {
        await onSave(verified, activate && selected ? providerRef(verified, selected) : null);
        onSaved(Boolean(activate && selected));
      }
    } catch (cause) {
      if (timedOut) setError("拉取模型超时，请检查 API 地址和网络。");
      else if (!abort.signal.aborted) setError(safeModelError(cause, verified.apiKey));
    } finally {
      if (timeout) clearTimeout(timeout);
      request.current = null;
      setTask(null);
      onBusy(false);
    }
  }

  const results = upstream.filter((model) => model.toLowerCase().includes(query.trim().toLowerCase()));
  const disabled = task !== null;

  return (
    <View style={styles.form}>
      <Text style={styles.label}>接口协议</Text>
      <View style={styles.protocols}>
        {supported.map((key) => (
          <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: draft.protocol === key, disabled }}
            disabled={disabled} onPress={() => changeProtocol(key)} style={[styles.chip, draft.protocol === key && styles.selected]}>
            <Text style={draft.protocol === key ? styles.selectedText : styles.secondaryText}>{protocols[key].label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.label}>供应商名称</Text>
      <TextInput accessibilityLabel="供应商名称" style={styles.input} editable={!disabled} value={draft.name}
        onChangeText={(value) => update("name", value)} placeholder="例如 DeepSeek、本地 Ollama" placeholderTextColor={colors.secondary} />
      <Text style={styles.label}>API 基础地址</Text>
      <TextInput accessibilityLabel="API 基础地址" style={styles.input} editable={!disabled} value={draft.endpoint}
        onChangeText={(value) => update("endpoint", value)} placeholder={protocols[draft.protocol].endpoint} placeholderTextColor={colors.secondary}
        autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Text style={styles.label}>API Key</Text>
      <TextInput accessibilityLabel="API Key" style={styles.input} editable={!disabled} value={draft.apiKey}
        onChangeText={(value) => update("apiKey", value)} placeholder="输入供应商提供的 Key" placeholderTextColor={colors.secondary}
        autoCapitalize="none" autoCorrect={false} secureTextEntry />
      {draft.endpoint.trim().toLowerCase().startsWith("http://") ? <Text style={styles.caption}>局域网 HTTP 不加密。服务无需鉴权时，Key 可留空。</Text> : null}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>模型</Text>
        <Pressable accessibilityRole="button" disabled={disabled} onPress={() => { void operate("list"); }} style={styles.fetch}>
          {task === "list" ? <ActivityIndicator size="small" color={colors.accent} /> : <Download color={colors.accent} size={17} />}
          <Text style={styles.link}>{task === "list" ? "正在拉取" : "拉取模型"}</Text>
        </Pressable>
      </View>
      <View style={styles.manual}>
        <TextInput accessibilityLabel="手动添加模型 ID" style={[styles.input, styles.grow]} editable={!disabled}
          value={manualModel} onChangeText={setManualModel} onSubmitEditing={() => addModel(manualModel)}
          placeholder="手动输入模型 ID" placeholderTextColor={colors.secondary} autoCapitalize="none" autoCorrect={false} />
        <Pressable accessibilityRole="button" accessibilityLabel="添加模型" disabled={disabled || !manualModel.trim()}
          onPress={() => addModel(manualModel)} style={styles.icon}>
          <Plus color={colors.accent} size={23} />
        </Pressable>
      </View>
      {draft.models.map((model) => (
        <View key={model} style={[styles.model, activeModel === model && styles.selected]}>
          <Pressable accessibilityRole="radio" accessibilityState={{ checked: activeModel === model }} disabled={disabled}
            onPress={() => { setActiveModel(model); setNotice(""); }} style={[styles.grow, styles.modelName]}>
            {activeModel === model ? <Check color={colors.accent} size={17} /> : null}
            <Text style={styles.name} numberOfLines={1}>{model}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={"移除模型 " + model} disabled={disabled} onPress={() => removeModel(model)} style={styles.icon}>
            <X color={colors.secondary} size={18} />
          </Pressable>
        </View>
      ))}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" disabled={disabled || !draft.models.length} onPress={() => { void operate("test"); }} style={[styles.test, !draft.models.length && styles.disabled]}>
          {task === "test" ? <ActivityIndicator size="small" color={colors.accent} /> : <FlaskConical color={colors.accent} size={17} />}
          <Text style={styles.link}>{task === "test" ? "正在测试" : "测试连接"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={disabled} onPress={() => { void operate("save", true); }} style={styles.primary}>
          {task === "save" ? <ActivityIndicator size="small" color={colors.accentInk} /> :
            <Text style={styles.primaryText}>{draft.models.length ? "保存并使用" : "保存供应商"}</Text>}
        </Pressable>
      </View>
      {draft.models.length ? (
        <Pressable accessibilityRole="button" disabled={disabled} onPress={() => { void operate("save"); }} style={styles.secondary}>
          <Text style={styles.secondaryText}>仅保存供应商</Text>
        </Pressable>
      ) : null}
      {upstream.length ? (
        <View style={styles.results}>
          <TextInput accessibilityLabel="搜索上游模型" value={query} onChangeText={(value) => { setQuery(value); setLimit(40); }}
            placeholder="搜索上游模型" placeholderTextColor={colors.secondary} style={styles.input} autoCapitalize="none" autoCorrect={false} />
          {results.slice(0, limit).map((model) => (
            <Pressable key={model} accessibilityRole="button" accessibilityLabel={"添加上游模型 " + model}
              disabled={disabled || draft.models.includes(model)} onPress={() => addModel(model)} style={styles.result}>
              <Text style={[styles.name, styles.grow]} numberOfLines={1}>{model}</Text>
              {draft.models.includes(model) ? <Check color={colors.accent} size={16} /> : <Plus color={colors.accent} size={16} />}
            </Pressable>
          ))}
          {!results.length ? <Text style={styles.caption}>没有匹配的模型。</Text> : null}
          {results.length > limit ? (
            <Pressable accessibilityRole="button" onPress={() => setLimit(limit + 40)} style={styles.fetch}>
              <Text style={styles.link}>显示更多</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 8 },
  label: { color: colors.text, fontSize: 14, fontWeight: "600", marginTop: 7 },
  protocols: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11 },
  selected: { backgroundColor: colors.tint, borderColor: colors.tintBorder },
  selectedText: { color: colors.accent, fontWeight: "600", fontSize: 13 },
  secondaryText: { color: colors.secondary, fontSize: 13 },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, color: colors.text, fontSize: 15, backgroundColor: colors.surface },
  caption: { color: colors.secondary, fontSize: 13, lineHeight: 20, margin: 2 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 15 },
  sectionTitle: { color: colors.text, fontWeight: "600", fontSize: 19 },
  fetch: { paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 8, minHeight: 42 },
  link: { color: colors.accent, fontWeight: "600", fontSize: 14 },
  manual: { flexDirection: "row", alignItems: "center", gap: 6 },
  grow: { flex: 1 },
  icon: { alignItems: "center", justifyContent: "center", width: 44, height: 44 },
  model: { borderRadius: 12, borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", backgroundColor: colors.surface },
  modelName: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 46, paddingLeft: 12 },
  name: { color: colors.text, fontSize: 14, flexShrink: 1 },
  results: { marginTop: 3, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 10, backgroundColor: colors.surface, gap: 2 },
  result: { flexDirection: "row", alignItems: "center", minHeight: 43, paddingHorizontal: 8, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  error: { color: colors.error, fontSize: 14, lineHeight: 21, marginTop: 4 },
  notice: { color: colors.accent, fontSize: 14, lineHeight: 21, marginTop: 4 },
  actions: { flexDirection: "row", gap: 10, marginTop: 8 },
  primary: { borderRadius: 14, minHeight: 48, alignItems: "center", justifyContent: "center", flex: 1, backgroundColor: colors.accent },
  primaryText: { color: colors.accentInk, fontWeight: "700", fontSize: 14 },
  test: { borderRadius: 14, minHeight: 48, alignItems: "center", justifyContent: "center", flex: 1, flexDirection: "row", gap: 8, borderWidth: 1, borderColor: colors.tintBorder },
  disabled: { opacity: 0.48 },
  secondary: { minHeight: 42, alignItems: "center", justifyContent: "center" },
});
