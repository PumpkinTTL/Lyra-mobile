import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { Check, ChevronDown, Download, FlaskConical, Plus, X } from "lucide-react-native";
import { testModelConnection } from "./agent";
import { localId } from "./conversations";
import { defaultContextWindow, fetchProviderCatalog, modelOptions, normalizeProvider, protocols, providerRef, reasoningChoices, safeModelError, thinkingLabels, thinkingLevels, type ModelOptions, type ModelRef, type Protocol, type Provider, type UpstreamModel } from "./model-catalog";
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
  const [upstream, setUpstream] = useState<UpstreamModel[]>([]);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(40);
  const [task, setTask] = useState<"list" | "test" | "save" | null>(null);
  const [showModelOptions, setShowModelOptions] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  function update(field: "name" | "endpoint" | "apiKey", value: string) {
    setDraft((current) => ({ ...current, [field]: value, ...(field === "endpoint" ? { modelMetadata: undefined } : {}) }));
    setError("");
    setNotice("");
    if (field !== "name") setUpstream([]);
  }

  function changeProtocol(protocol: Protocol) {
    if (protocol === draft.protocol) return;
    setDraft({ ...draft, protocol, endpoint: "", modelMetadata: undefined });
    setUpstream([]);
    setError("");
    setNotice("");
  }

  function addModel(value: string, entry?: UpstreamModel) {
    const model = value.trim();
    if (!model) return;
    setDraft((previous) => ({ ...previous, models: previous.models.includes(model) ? previous.models : [...previous.models, model],
      ...(entry ? { modelMetadata: { ...previous.modelMetadata, [model]: entry.options } } : {}) }));
    setActiveModel(model);
    setShowModelOptions(true);
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
        const models = await fetchProviderCatalog(verified, fetch, abort.signal);
        setUpstream(models);
        setDraft((previous) => ({ ...previous, modelMetadata: { ...previous.modelMetadata,
          ...Object.fromEntries(models.filter(({ id }) => previous.models.includes(id)).map(({ id, options }) => [id, options])) } }));
        setLimit(40);
        setQuery("");
        setNotice(models.length ? "已拉取 " + models.length + " 个模型，并导入供应商提供的能力和参数。" : "供应商没有返回可用模型，可手动添加。");
      } else if (action === "test") {
        if (!selected) throw new Error("请先添加并选中要测试的模型。");
        await testModelConnection({ ...verified, model: selected, options: modelOptions(verified, selected) }, streamingFetch, abort.signal);
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

  function setModelOption<K extends keyof ModelOptions>(name: K, value: ModelOptions[K]) {
    setDraft((old) => {
      const next = { ...old.modelOptions?.[activeModel] };
      if (value === undefined) delete next[name];
      else next[name] = value;
      return { ...old, modelOptions: { ...old.modelOptions, [activeModel]: next } };
    });
    setError("");
  }

  const results = upstream.filter(({ id, name }) => `${id} ${name ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const disabled = task !== null;
  const options = modelOptions(draft, activeModel);
  const manual = draft.modelOptions?.[activeModel];
  const inherited = draft.modelMetadata?.[activeModel];
  const hasOverrides = Object.keys(manual ?? {}).length > 0;

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
      <Text style={styles.caption}>支持 HTTP 和 HTTPS，请填写手机能访问的服务地址。</Text>
      <Text style={styles.label}>API Key</Text>
      <TextInput accessibilityLabel="API Key" style={styles.input} editable={!disabled} value={draft.apiKey}
        onChangeText={(value) => update("apiKey", value)} placeholder="输入供应商提供的 Key" placeholderTextColor={colors.secondary}
        autoCapitalize="none" autoCorrect={false} secureTextEntry />
      {draft.endpoint.trim().toLowerCase().startsWith("http://") ? <Text style={styles.caption}>HTTP 以明文传输。服务无需鉴权时，Key 可留空。</Text> : null}
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
            onPress={() => { if (model === activeModel) setShowModelOptions(!showModelOptions); else { setActiveModel(model); setShowModelOptions(true); } }} style={[styles.grow, styles.modelName]}>
            {activeModel === model ? <Check color={colors.accent} size={17} /> : null}
            <Text style={[styles.name, styles.grow]} numberOfLines={1}>{model}</Text>
            <ChevronDown color={colors.secondary} size={17} style={activeModel === model && showModelOptions ? styles.up : undefined} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={"移除模型 " + model} disabled={disabled} onPress={() => removeModel(model)} style={styles.icon}>
            <X color={colors.secondary} size={18} />
          </Pressable>
        </View>
      ))}
      {activeModel && showModelOptions ? (
        <View style={styles.modelOptions}>
          <View style={styles.optionRow}><Text style={[styles.name, styles.grow]}>{activeModel} · 模型能力</Text>
            {hasOverrides ? <Pressable accessibilityRole="button" disabled={disabled} onPress={() => setDraft((old) => ({ ...old,
              modelOptions: { ...old.modelOptions, [activeModel]: {} } }))} style={styles.fetch}><Text style={styles.link}>恢复自动</Text></Pressable> : null}
          </View>
          {([['contextWindow', '上下文长度', String(defaultContextWindow)], ['maxTokens', '最大输出 Token', '自动']] as const).map(([key, title, placeholder]) => (
            <View key={key} style={styles.optionRow}>
              <View style={styles.grow}><Text style={styles.label}>{title}</Text><Text style={styles.caption}>{inherited?.[key] ? `上游：${inherited[key]}` : key === "maxTokens" ? "留空使用协议默认策略" : "用于管理和压缩对话历史"}</Text></View>
              <TextInput accessibilityLabel={title} inputMode="numeric" maxLength={7} placeholder={inherited?.[key]?.toString() ?? placeholder} placeholderTextColor={colors.secondary}
                editable={!disabled} style={[styles.input, styles.optionNumber]} value={manual?.[key]?.toString() ?? ""}
                onChangeText={(text) => setModelOption(key, text.replace(/\D/g, "") ? Number(text.replace(/\D/g, "")) : undefined)} />
            </View>
          ))}
          {([['images', '支持图片'], ['reasoning', '支持思考']] as const).map(([key, title]) => (
            <View key={key} style={styles.optionRow}>
              <View style={styles.grow}><Text style={styles.label}>{title}</Text><Text style={styles.caption}>{manual?.[key] !== undefined ? "已手动设置" : inherited?.[key] !== undefined ? "来自上游" : "上游未声明"}</Text></View>
              <Switch accessibilityLabel={title} value={options[key] ?? true} disabled={disabled}
                onValueChange={(value) => setModelOption(key, value)} />
            </View>
          ))}
          {options.reasoning !== false ? <>
            <View style={styles.optionRow}><Text style={[styles.label, styles.grow]}>支持思考档位</Text>
              <Switch accessibilityLabel="支持思考档位" disabled={disabled} value={reasoningChoices(options).length > 0}
                onValueChange={(enabled) => setModelOption("thinkingLevels", enabled ? ["low", "medium", "high"] : [])} />
            </View>
            {reasoningChoices(options).length ? <View style={styles.protocols}>{thinkingLevels.map((level) => {
              const levels = reasoningChoices(options);
              const selected = levels.includes(level);
              return <Pressable key={level} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} disabled={disabled}
                onPress={() => setModelOption("thinkingLevels", selected ? levels.filter((item) => item !== level) : thinkingLevels.filter((item) => item === level || levels.includes(item)))}
                style={[styles.chip, selected && styles.selected]}><Text style={selected ? styles.selectedText : styles.secondaryText}>{thinkingLabels[level]}</Text></Pressable>;
            })}</View> : null}
          </> : null}
        </View>
      ) : null}
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
          {results.slice(0, limit).map((entry) => (
            <Pressable key={entry.id} accessibilityRole="button" accessibilityLabel={"添加上游模型 " + entry.id}
              disabled={disabled} onPress={() => { addModel(entry.id, entry); setUpstream([]); }} style={styles.result}>
              <View style={styles.grow}><Text style={styles.name} numberOfLines={1}>{entry.name || entry.id}</Text>
                {entry.options.contextWindow || entry.options.maxTokens ? <Text style={styles.caption}>{[entry.options.contextWindow ? `${entry.options.contextWindow} 上下文` : "", entry.options.maxTokens ? `${entry.options.maxTokens} 输出` : ""].filter(Boolean).join(" · ")}</Text> : null}</View>
              {draft.models.includes(entry.id) ? <Check color={colors.accent} size={16} /> : <Plus color={colors.accent} size={16} />}
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
  modelOptions: { padding: 12, gap: 4, borderRadius: 10, backgroundColor: colors.tint },
  optionNumber: { width: 96, minHeight: 38 },
  optionRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  up: { transform: [{ rotate: "180deg" }] },
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
