import { gzipSync as compress, gunzipSync as decompress } from "fflate";

export const constants = { Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1 };
const maximumBytes = 16 * 1024 * 1024;

export function gzipSync(bytes, options = {}) {
  const level = options.level;
  return compress(bytes, level >= 0 && level <= 9 ? { level } : {});
}

export function gunzipSync(bytes, options = {}) {
  const limit = Math.min(options.maxOutputLength ?? maximumBytes, maximumBytes);
  if (bytes.length < 18) throw new Error("Invalid gzip data");
  const length = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4).getUint32(0, true);
  if (length > limit) throw new Error("gzip output is too large");
  const output = decompress(bytes);
  if (output.length > limit) throw new Error("gzip output is too large");
  return output;
}
