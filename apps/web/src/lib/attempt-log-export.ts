import { setImmediate } from "node:timers/promises";
import { DomainError } from "@autoforge/domain";
import type { AttemptLogPage } from "@autoforge/contracts";
import { parseSafeAnsiStream, type AnsiParserState } from "./safe-ansi";

export type ExportLogPageReader = (input: {
  attemptId: string;
  stream: "stdout" | "stderr" | "agent";
  afterSequence: number;
  limit: number;
}) => Promise<
  Pick<AttemptLogPage, "nextSequence"> &
    Partial<Pick<AttemptLogPage, "truncated">> & { items: readonly { content: string }[] }
>;

/** Preserve readable output, with one bounded page and ANSI state per stream. */
export async function* attemptLogExportText(
  readPage: ExportLogPageReader,
  attemptId: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  let hasStream = false;
  let collectionWasTruncated = false;
  for (const stream of ["stdout", "stderr", "agent"] as const) {
    let afterSequence = -1;
    let state: AnsiParserState | undefined;
    let startedStream = false;
    let previousCarriageReturn = false;
    for (;;) {
      signal.throwIfAborted();
      const page = await readPage({ attemptId, stream, afterSequence, limit: 32 });
      signal.throwIfAborted();
      collectionWasTruncated ||= page.truncated === true;
      for (const chunk of page.items) {
        const parsed = parseSafeAnsiStream(chunk.content, state);
        state = parsed.state;
        for (const segment of parsed.segments) {
          if (!segment.text) continue;
          if (!startedStream) {
            yield `${hasStream ? "\n" : ""}===== ${stream} =====\n`;
            hasStream = true;
            startedStream = true;
          }
          let text = segment.text;
          if (previousCarriageReturn && text.startsWith("\n")) text = text.slice(1);
          previousCarriageReturn = segment.text.endsWith("\r");
          text = text.replace(/\r\n?/gu, "\n");
          if (text) yield text;
        }
      }
      if (page.nextSequence === undefined) break;
      if (page.nextSequence <= afterSequence) {
        throw new DomainError("LOG_EXPORT_CURSOR_STALLED", "日志分页游标未前进，请重试导出。", {
          details: { attemptId, stream },
        });
      }
      afterSequence = page.nextSequence;
      await setImmediate(undefined, { signal });
    }
  }
  if (collectionWasTruncated)
    yield "\n[平台提示] 此执行采集日志时已达到大小上限；本文件包含全部已保存日志。\n";
}
