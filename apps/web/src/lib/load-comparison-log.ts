import { attemptLogPageSchema, type LogChunk } from "@autoforge/contracts";

import { MAXIMUM_COMPARISON_CHARACTERS } from "./attempt-log-diff";
import { readApiErrorMessage } from "./client-api";

export type ComparisonLog = { text: string; limited: boolean; incomplete: boolean };
export type ComparisonLogStream = LogChunk["stream"];
export type ComparisonLogProgress = {
  loadedCharacters: number;
  loadedChunks: number;
};
const MAXIMUM_COMPARISON_PAGES = 20;

export async function loadComparisonLog(
  attemptId: string,
  stream: ComparisonLogStream,
  signal: AbortSignal,
  onProgress?: (progress: ComparisonLogProgress) => void,
): Promise<ComparisonLog> {
  let text = "";
  let afterSequence = -1;
  let incomplete = false;
  let loadedChunks = 0;
  for (let pageNumber = 0; pageNumber < MAXIMUM_COMPARISON_PAGES; pageNumber += 1) {
    const query = new URLSearchParams({
      stream,
      afterSequence: String(afterSequence),
      limit: "20",
    });
    const response = await fetch(
      `/api/v1/run-attempts/${encodeURIComponent(attemptId)}/logs?${query}`,
      {
        cache: "no-store",
        signal,
      },
    );
    if (!response.ok) throw new Error(await readApiErrorMessage(response, "读取对比日志失败。"));
    const page = attemptLogPageSchema.parse(await response.json());
    let lastSequence = afterSequence;
    for (const chunk of page.items) {
      if (chunk.stream !== stream || chunk.sequence <= lastSequence) continue;
      if (chunk.sequence !== lastSequence + 1) incomplete = true;
      lastSequence = chunk.sequence;
      loadedChunks += 1;
      const remaining = MAXIMUM_COMPARISON_CHARACTERS - text.length;
      text += chunk.content.slice(0, remaining);
      if (chunk.content.length > remaining) {
        onProgress?.({
          loadedCharacters: text.length,
          loadedChunks,
        });
        return { text, limited: true, incomplete };
      }
    }
    onProgress?.({
      loadedCharacters: text.length,
      loadedChunks,
    });
    incomplete ||= page.truncated;
    if (page.nextSequence === undefined) return { text, limited: false, incomplete };
    if (page.nextSequence <= afterSequence) throw new Error("日志分页未前进，请重新加载后再试。");
    afterSequence = page.nextSequence;
  }
  return { text, limited: true, incomplete };
}
