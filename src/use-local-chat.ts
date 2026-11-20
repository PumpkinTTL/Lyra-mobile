import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react-native";
import { fetch as nativeFetch } from "react-native-fetch-api";
import { createLocalAgent, type ModelSettings } from "./agent";
import { toThreadMessages } from "./chat-messages";
import { loadMessages, loadSettings, readLocalNote, saveMessages, saveSettings } from "./storage";

type LocalSession = ReturnType<typeof createLocalAgent> & { settings: ModelSettings | null };

const streamingFetch: typeof fetch = (input, options) =>
  nativeFetch(input, { ...options, reactNative: { textStreaming: true } });

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useLocalChat() {
  const session = useRef<LocalSession | null>(null);
  const unsubscribe = useRef<(() => void) | undefined>(undefined);
  const working = useRef(false);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [error, setError] = useState("");

  const attach = useCallback((active: LocalSession) => {
    unsubscribe.current?.();
    session.current = active;
    const update = () => {
      const state = active.agent.state;
      setMessages(toThreadMessages(state.messages, state.streamingMessage, working.current));
    };
    unsubscribe.current = active.agent.subscribe(update);
    setSettings(active.settings);
    update();
    setReady(true);
  }, []);

  useEffect(() => {
    let mounted = true;
    async function restore() {
      try {
        const model = await loadSettings();
        const stored = await loadMessages(model);
        if (mounted) attach({ ...createLocalAgent({ settings: model, readLocalNote, messages: stored, fetch: streamingFetch }), settings: model });
      } catch (cause) {
        if (mounted) {
          setError("读取本地数据失败：" + errorText(cause));
          attach({ ...createLocalAgent({ settings: null, readLocalNote }), settings: null });
        }
      }
    }
    void restore();
    return () => {
      mounted = false;
      unsubscribe.current?.();
      session.current?.agent.abort();
    };
  }, [attach]);

  const send = useCallback(async (text: string) => {
    const active = session.current;
    if (!active || working.current || !text.trim()) return;
    working.current = true;
    setRunning(true);
    setError("");
    try {
      await active.send(text.trim());
      const state = active.agent.state;
      if (state.errorMessage && !state.messages.some((message) =>
        message.role === "assistant" && message.errorMessage === state.errorMessage,
      )) setError(state.errorMessage);
      await saveMessages(active.settings, state.messages);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      working.current = false;
      const state = active.agent.state;
      setMessages(toThreadMessages(state.messages, undefined, false));
      setRunning(false);
    }
  }, []);

  const stop = useCallback(() => session.current?.agent.abort(), []);

  const reset = useCallback(async () => {
    const active = session.current;
    if (!active || working.current) return;
    working.current = true;
    try {
      await saveMessages(active.settings, []);
      active.agent.reset();
      setMessages([]);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      working.current = false;
    }
  }, []);

  const configure = useCallback(async (next: ModelSettings | null) => {
    if (working.current) throw new Error("请先结束当前回复");
    working.current = true;
    try {
      const stored = await loadMessages(next);
      const agent = createLocalAgent({ settings: next, readLocalNote, messages: stored, fetch: streamingFetch });
      await saveSettings(next);
      attach({ ...agent, settings: next });
      setError("");
    } finally {
      working.current = false;
    }
  }, [attach]);

  return { ready, running, settings, messages, error, send, stop, reset, configure };
}
