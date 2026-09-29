import type { LogChunk } from "@autoforge/contracts";

/** Keep live output bounded even when a single chunk contains a very large stack trace. */
export function debugLogWindow(previous: readonly LogChunk[], incoming: readonly LogChunk[]) {
  const merged = new Map(previous.map((chunk) => [chunk.sequence, chunk]));
  for (const chunk of incoming) merged.set(chunk.sequence, chunk);
  const ordered = [...merged.values()].sort((left, right) => left.sequence - right.sequence);
  const items: LogChunk[] = [];
  let remainingCharacters = 256 * 1_024;
  let trimmed = ordered.length > 200;
  for (const chunk of ordered.slice(-200).reverse()) {
    if (remainingCharacters === 0) {
      trimmed = true;
      break;
    }
    const content = chunk.content.slice(-remainingCharacters);
    trimmed ||= content.length < chunk.content.length;
    remainingCharacters -= content.length;
    items.unshift({ ...chunk, content });
  }
  return { items, trimmed };
}
