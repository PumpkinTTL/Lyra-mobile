declare module "@ungap/structured-clone" {
  export default function clone<T>(value: T): T;
}

declare module "react-native-fetch-api" {
  export const Response: new (body: ReadableStream<Uint8Array>, init: ResponseInit & { url: string }) => Response;
}
