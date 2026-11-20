import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Keychain from "react-native-keychain";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModelSettings } from "./agent";

const credentialService = "com.lyramobile.model";

export async function loadSettings(): Promise<ModelSettings | null> {
  const account = await Keychain.getGenericPassword({ service: credentialService });
  return account ? JSON.parse(account.password) as ModelSettings : null;
}

export async function saveSettings(settings: ModelSettings | null) {
  if (settings) {
    const saved = await Keychain.setGenericPassword("lyra", JSON.stringify(settings), { service: credentialService });
    if (!saved) throw new Error("无法保存模型连接");
  } else {
    await Keychain.resetGenericPassword({ service: credentialService });
  }
}

function chatKey(settings: ModelSettings | null) {
  return settings
    ? "lyra.chat.model.v1:" + encodeURIComponent(settings.endpoint) + ":" + encodeURIComponent(settings.model)
    : "lyra.chat.demo.v1";
}

export async function loadMessages(settings: ModelSettings | null): Promise<AgentMessage[]> {
  const stored = await AsyncStorage.getItem(chatKey(settings));
  if (!stored) return [];
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) throw new Error("无法恢复本机会话");
  return parsed as AgentMessage[];
}

export async function saveMessages(settings: ModelSettings | null, messages: AgentMessage[]) {
  await AsyncStorage.setItem(chatKey(settings), JSON.stringify(messages));
}


export async function readLocalNote(): Promise<string> {
  const key = "lyra.sample-note.v1";
  const cached = await AsyncStorage.getItem(key);
  if (cached !== null) return cached;
  const note = "项目：Lyra Mobile\n当前里程碑：在手机上跑通本地 Agent 与工具调用。\n下一步：连接你自己的模型。";
  await AsyncStorage.setItem(key, note);
  return note;
}
