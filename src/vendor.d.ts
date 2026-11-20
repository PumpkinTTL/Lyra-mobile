declare module "@ungap/structured-clone" {
  export default function clone<T>(value: T): T;
}

declare module "react-native-fetch-api" {
  export function fetch(
    input: RequestInfo | URL,
    options?: RequestInit & { reactNative?: { textStreaming?: boolean } },
  ): Promise<Response>;
}
