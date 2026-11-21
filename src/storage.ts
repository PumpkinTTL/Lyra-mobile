import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Keychain from "react-native-keychain";
import { deleteTranscript, loadTranscript, saveTranscript, workspaceSupported } from "./device-workspace";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { newConversation, userTitle, type Conversation, type Workspace } from "./conversations";
import { type ModelConnection, type ModelRef, type Provider } from "./model-catalog";

const credentialService = "com.lyramobile.model";
const workspaceKey = "lyra.workspace.v2";
const legacyDemoKey = "lyra.chat.demo.v1";
const legacyPrefix = "lyra.chat.model.v1:";
const messageKey = (id: string) => "lyra.conversation.v2:" + id;

function parseMessages(stored: string | null): AgentMessage[] {
  if (!stored) return [];
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) throw new Error("无法恢复本机会话。");
  return parsed as AgentMessage[];
}

export async function saveProviders(providers: Provider[]) {
  const saved = await Keychain.setGenericPassword("lyra", JSON.stringify({ providers }), { service: credentialService });
  if (!saved) throw new Error("无法保存模型供应商。");
}

async function loadProviders(): Promise<{ providers: Provider[]; legacyModel: ModelRef }> {
  const account = await Keychain.getGenericPassword({ service: credentialService });
  if (!account) return { providers: [], legacyModel: null };

  const stored = JSON.parse(account.password) as { providers: Provider[] } | ModelConnection;
  if ("providers" in stored) return { providers: stored.providers, legacyModel: null };
  const provider: Provider = {
    id: "legacy-provider",
    name: "原有供应商",
    protocol: stored.protocol ?? "openai",
    endpoint: stored.endpoint,
    apiKey: stored.apiKey,
    models: [stored.model],
  };
  return { providers: [provider], legacyModel: { providerId: provider.id, model: stored.model } };
}

export async function openStorage(): Promise<{ providers: Provider[]; workspace: Workspace }> {
  // Retire SSH presets from older installations without reading their credentials.
  await Keychain.resetGenericPassword({ service: "com.lyramobile.ssh" }).catch(() => {});
  const { providers, legacyModel } = await loadProviders();
  const existing = await AsyncStorage.getItem(workspaceKey);
  if (existing) return { providers, workspace: JSON.parse(existing) as Workspace };

  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key === legacyDemoKey || key.startsWith(legacyPrefix));
  const entries = await AsyncStorage.multiGet(keys);
  const conversations: Conversation[] = [];
  const migrated: [string, string][] = [];

  for (const [key, stored] of entries) {
    const messages = parseMessages(stored);
    if (!messages.some((message) => message.role === "user")) continue;
    let model: ModelRef = null;
    if (key.startsWith(legacyPrefix)) {
      const [endpoint, id] = key.slice(legacyPrefix.length).split(":").map(decodeURIComponent);
      const provider = providers.find((item) => item.endpoint === endpoint && item.models.includes(id));
      model = { providerId: provider?.id ?? "legacy-unavailable", model: id };
    }
    const conversation = {
      ...newConversation(model),
      title: userTitle(messages),
      updatedAt: messages[messages.length - 1]?.timestamp ?? Date.now(),
    };
    conversations.push(conversation);
    migrated.push([messageKey(conversation.id), JSON.stringify(messages)]);
  }

  const active = (legacyModel ? conversations.find((item) => item.model?.providerId === legacyModel.providerId) : conversations.find((item) => !item.model))
    ?? newConversation(legacyModel);
  if (!conversations.includes(active)) conversations.push(active);

  const workspace = { activeId: active.id, conversations };
  migrated.push([workspaceKey, JSON.stringify(workspace)]);
  await AsyncStorage.multiSet(migrated);
  return { providers, workspace };
}

export function saveWorkspace(workspace: Workspace) {
  return AsyncStorage.setItem(workspaceKey, JSON.stringify(workspace));
}

export async function loadMessages(id: string): Promise<AgentMessage[]> {
  const stored = workspaceSupported() ? await loadTranscript(id) : null;
  return parseMessages(stored ?? await AsyncStorage.getItem(messageKey(id)));
}

export async function saveMessages(workspace: Workspace, id: string, messages: AgentMessage[]) {
  const saved = JSON.stringify(messages);
  if (workspaceSupported()) {
    await saveTranscript(id, saved);
    await AsyncStorage.setItem(workspaceKey, JSON.stringify(workspace));
    return;
  }
  await AsyncStorage.multiSet([[messageKey(id), saved], [workspaceKey, JSON.stringify(workspace)]]);
}

export async function checkpointMessages(id: string, messages: AgentMessage[]) {
  const payload = JSON.stringify(messages);
  if (workspaceSupported()) return saveTranscript(id, payload);
  return AsyncStorage.setItem(messageKey(id), payload);
}

export async function removeMessages(id: string) {
  if (workspaceSupported()) await deleteTranscript(id);
  await AsyncStorage.removeItem(messageKey(id));
}
