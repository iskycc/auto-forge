import { randomBytes } from "node:crypto";

export function uuidV7(nowMs = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 0xffffffffffff) {
    throw new RangeError("UUIDv7 timestamp is out of range.");
  }
  const bytes = randomBytes(16);
  let timestamp = BigInt(nowMs);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
