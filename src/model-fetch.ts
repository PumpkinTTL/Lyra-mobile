import { fetch as nativeFetch } from "react-native-fetch-api";

export const streamingFetch: typeof fetch = async (input, options) => {
  const request = typeof input === "object" && "url" in input ? input : undefined;
  const method = options?.method ?? request?.method ?? "GET";
  const headers: Record<string, string> = {};
  new Headers(options?.headers ?? request?.headers).forEach((value, name) => { headers[name] = value; });
  const body = options?.body ?? (request && !/^(GET|HEAD)$/i.test(method) ? await request.text() : undefined);
  return nativeFetch(request?.url ?? String(input), {
    credentials: request?.credentials,
    signal: request?.signal,
    ...options,
    method,
    headers,
    body,
    reactNative: { textStreaming: true },
  });
};
