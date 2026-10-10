import { logChunkSchema, type LogChunk } from "@autoforge/contracts";
import { z } from "zod";
import { SHARED_LOG_MAX_BYTES } from "./shared-attempt-log";

const MAXIMUM_LOG_CHUNKS = 1_024;
const MAXIMUM_FRAME_CHARACTERS = 3 * 1024 * 1024;
const frameSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal("chunks"),
  attemptId: z.string(),
  chunks: z.array(logChunkSchema).max(256),
});

export function parseManualLogFrame(payload: unknown, attemptId: string): LogChunk[] | null {
  if (typeof payload !== "string" || payload.length > MAXIMUM_FRAME_CHARACTERS) return null;
  try {
    const frame = frameSchema.safeParse(JSON.parse(payload));
    return frame.success && frame.data.attemptId === attemptId ? frame.data.chunks : null;
  } catch {
    return null;
  }
}

export function mergeManualLogWindow(
  current: LogChunk[],
  incoming: LogChunk[],
): { chunks: LogChunk[]; truncated: boolean } {
  const bySequence = new Map(current.map((chunk) => [`${chunk.stream}:${chunk.sequence}`, chunk]));
  for (const chunk of incoming) {
    if (chunk.stream !== "agent") bySequence.set(`${chunk.stream}:${chunk.sequence}`, chunk);
  }
  const chunks = [...bySequence.values()].sort(
    (left, right) =>
      left.recordedAt.localeCompare(right.recordedAt) ||
      left.stream.localeCompare(right.stream) ||
      left.sequence - right.sequence,
  );
  const encoder = new TextEncoder();
  let bytes = chunks.reduce((total, chunk) => total + encoder.encode(chunk.content).byteLength, 0);
  let truncated = false;
  while (
    chunks.length > 1 &&
    (chunks.length > MAXIMUM_LOG_CHUNKS || bytes > SHARED_LOG_MAX_BYTES)
  ) {
    bytes -= encoder.encode(chunks.shift()!.content).byteLength;
    truncated = true;
  }
  if (bytes > SHARED_LOG_MAX_BYTES && chunks[0]) {
    const encoded = encoder.encode(chunks[0].content);
    let start = encoded.length - SHARED_LOG_MAX_BYTES;
    while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1;
    chunks[0] = { ...chunks[0], content: new TextDecoder().decode(encoded.subarray(start)) };
    truncated = true;
  }
  return { chunks, truncated };
}
