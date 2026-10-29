import { createHash, type Hash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { AttemptLogItem } from "./attempt-log-store";
export const ARCHIVE_FRAME_HEADER_BYTES = 48;
export const ARCHIVE_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export const archiveStreams = ["stdout", "stderr", "agent"] as const;
export function encodeArchiveFrame(rows: unknown[]): Buffer {
  const plain = Buffer.from(JSON.stringify(rows));
  if (plain.length > ARCHIVE_MAX_FRAME_BYTES)
    throw new Error("Archive frame exceeds its bounded size.");
  const compressed = gzipSync(plain, { level: 6 });
  const header = Buffer.alloc(ARCHIVE_FRAME_HEADER_BYTES);
  header.write("AFLC");
  header.writeUInt16LE(1, 4);
  header.writeUInt32LE(compressed.length, 8);
  header.writeUInt32LE(plain.length, 12);
  createHash("sha256").update(plain).digest().copy(header, 16);
  return Buffer.concat([header, compressed]);
}
export function decodeArchiveFrame<T>(buffer: Buffer): T[] {
  if (
    buffer.length < ARCHIVE_FRAME_HEADER_BYTES ||
    buffer.toString("ascii", 0, 4) !== "AFLC" ||
    buffer.readUInt16LE(4) !== 1
  )
    throw new Error("Invalid archive frame header.");
  const size = buffer.readUInt32LE(12);
  if (
    size > ARCHIVE_MAX_FRAME_BYTES ||
    buffer.readUInt32LE(8) !== buffer.length - ARCHIVE_FRAME_HEADER_BYTES
  )
    throw new Error("Invalid archive frame length.");
  const plain = gunzipSync(buffer.subarray(ARCHIVE_FRAME_HEADER_BYTES), {
    maxOutputLength: ARCHIVE_MAX_FRAME_BYTES,
  });
  if (
    plain.length !== size ||
    !createHash("sha256").update(plain).digest().equals(buffer.subarray(16, 48))
  )
    throw new Error("Archive frame checksum mismatch.");
  const rows: unknown = JSON.parse(plain.toString("utf8"));
  if (!Array.isArray(rows)) throw new Error("Invalid archive frame payload.");
  return rows as T[];
}
export function hashArchiveChunk(hash: Hash, chunk: AttemptLogItem): void {
  const timestamp = Buffer.from(chunk.recordedAt);
  const content = Buffer.from(chunk.content);
  const prefix = Buffer.alloc(12);
  prefix.writeBigUInt64LE(BigInt(chunk.sequence));
  prefix.writeUInt32LE(timestamp.length, 8);
  const contentSize = Buffer.alloc(4);
  contentSize.writeUInt32LE(content.length);
  hash.update(prefix).update(timestamp).update(contentSize).update(content);
}

export type ArchivedLogChunk = AttemptLogItem & { attemptId: string; frameIndex: number };
