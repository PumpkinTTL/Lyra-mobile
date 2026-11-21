import * as ReactNative from "react-native";
import { Response as StreamingResponse } from "react-native-fetch-api";

type Events = {
  didReceiveNetworkResponse: [number, number, Record<string, string> | null, string | null];
  didReceiveNetworkIncrementalData: [number, string];
  didCompleteNetworkResponse: [number, string | null, boolean];
};

type Networking = {
  addListener<K extends keyof Events>(name: K, listener: (event: Events[K]) => void): { remove(): void };
  sendRequest(method: string, trackingName: string, url: string, headers: Record<string, string>, body: string | null,
    type: "text", incremental: boolean, timeout: number, onRequest: (id: number) => void, withCredentials: boolean): void;
  abortRequest(id: number): void;
};

const networking = (ReactNative as unknown as { Networking: Networking }).Networking;
const idleLimit = 150_000;

export const streamingFetch: typeof fetch = async (input, options) => {
  const request = typeof input === "object" && "url" in input ? input : undefined;
  const method = options?.method ?? request?.method ?? "GET";
  const url = request?.url ?? String(input);
  const signal = options?.signal ?? request?.signal;
  const headers: Record<string, string> = {};
  new Headers(options?.headers ?? request?.headers).forEach((value, name) => { headers[name] = value; });
  const body = options?.body ?? (request && !/^(GET|HEAD)$/i.test(method) ? await request.text() : null);
  if (body !== null && typeof body !== "string") throw new TypeError("模型请求需要 JSON 文本请求体。");

  return new Promise<Response>((resolve, reject) => {
    let requestId: number | undefined;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let receivedHeaders = false;
    let finished = false;
    let stopNative = false;
    let failure: Error | undefined;
    let waiting = false;
    let pendingBytes = 0;
    let surrogate = "";
    const pending: Uint8Array[] = [];
    const subscriptions: { remove(): void }[] = [];
    const encoder = new TextEncoder();

    function pump() {
      if (!waiting) return;
      const chunk = pending.shift();
      if (chunk) {
        waiting = false;
        pendingBytes -= chunk.byteLength;
        controller.enqueue(chunk);
      } else if (finished) {
        waiting = false;
        if (failure) controller.error(failure);
        else controller.close();
      }
    }

    function finish(error?: Error, abortNative = false) {
      if (finished) return;
      finished = true;
      failure = error;
      stopNative = abortNative;
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.remove());
      signal?.removeEventListener("abort", abort);
      if (abortNative && requestId !== undefined) networking.abortRequest(requestId);
      if (!receivedHeaders) reject(error ?? new Error("模型连接结束，未收到 HTTP 响应。"));
      else pump();
    }

    function abort() { finish(new Error("模型请求已停止。"), true); }

    function waitForData() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish(new Error(receivedHeaders ? "模型连接连续 150 秒没有收到数据，回复已中断。" : "等待模型网关响应超时（150 秒）。"), true);
      }, idleLimit);
    }

    function enqueue(text: string) {
      if (!text) return;
      const chunk = encoder.encode(text);
      pendingBytes += chunk.byteLength;
      if (pendingBytes > 8 * 1024 * 1024) {
        finish(new Error("模型响应积压超过 8 MB，回复已中断。"), true);
        return;
      }
      pending.push(chunk);
      pump();
    }

    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      pull() { waiting = true; pump(); },
      cancel() { waiting = false; finish(undefined, true); },
    }, { highWaterMark: 0 });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      subscriptions.push(networking.addListener("didReceiveNetworkResponse", ([id, status, responseHeaders, responseUrl]) => {
        if (id !== requestId || finished || receivedHeaders) return;
        receivedHeaders = true;
        waitForData();
        resolve(new StreamingResponse(stream, { status, headers: responseHeaders ?? {}, url: responseUrl ?? url }));
      }));
      subscriptions.push(networking.addListener("didReceiveNetworkIncrementalData", ([id, text]) => {
        if (id !== requestId || finished || !text) return;
        waitForData();
        const combined = surrogate + text;
        surrogate = /[\uD800-\uDBFF]$/.test(combined) ? combined.slice(-1) : "";
        enqueue(surrogate ? combined.slice(0, -1) : combined);
      }));
      subscriptions.push(networking.addListener("didCompleteNetworkResponse", ([id, error, timedOut]) => {
        if (id !== requestId || finished) return;
        if (!error && !timedOut) enqueue(surrogate);
        finish(timedOut ? new Error("模型连接超时，回复已中断。") : error
          ? new Error(receivedHeaders ? "接收模型回复时网络连接中断。" : "无法连接模型网关，请检查网络和 API 地址。") : undefined);
      }));
      waitForData();
      const credentials = options?.credentials ?? request?.credentials ?? "same-origin";
      networking.sendRequest(method, "Lyra model stream", url, headers, body, "text", true, 0, (id) => {
        requestId = id;
        if (stopNative) networking.abortRequest(id);
      }, credentials !== "omit");
    } catch (error) {
      finish(error instanceof Error ? error : new Error("无法启动模型请求。"), true);
    }
  });
};
