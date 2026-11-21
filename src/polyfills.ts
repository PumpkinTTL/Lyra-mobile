import clone from "@ungap/structured-clone";
import { ReadableStream } from "web-streams-polyfill";
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = clone;
}

if (typeof globalThis.ReadableStream !== "function") {
  globalThis.ReadableStream = ReadableStream as unknown as typeof globalThis.ReadableStream;
}
