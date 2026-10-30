import { visibleAttemptLogText } from "../lib/log-presentation";
import { highlightLogLevels } from "../lib/log-levels";
import { parseSafeAnsiStream, type AnsiParserState, type AnsiSegment } from "../lib/safe-ansi";

const MAXIMUM_WINDOW_CHARACTERS = 65536;
const MAXIMUM_WINDOW_SEGMENTS = 1500;

/** Rendering windows bound DOM work without truncating the downloaded log page. */
export function presentArchiveLogPage(
  chunks: readonly { content: string }[],
  state?: AnsiParserState,
) {
  const content = visibleAttemptLogText(
    chunks
      .map((chunk) => chunk.content)
      .join("")
      .replace(/\r\n?/g, "\n"),
  );
  const parsed = parseSafeAnsiStream(content, state);
  const segments = highlightLogLevels(parsed.segments);
  const windows: AnsiSegment[][] = [[]];
  let windowCharacters = 0;
  for (const segment of segments) {
    let offset = 0;
    while (offset < segment.text.length) {
      let window = windows.at(-1)!;
      if (
        windowCharacters === MAXIMUM_WINDOW_CHARACTERS ||
        window.length === MAXIMUM_WINDOW_SEGMENTS
      ) {
        windows.push([]);
        window = windows.at(-1)!;
        windowCharacters = 0;
      }
      let end = Math.min(
        segment.text.length,
        offset + MAXIMUM_WINDOW_CHARACTERS - windowCharacters,
      );
      const last = segment.text.charCodeAt(end - 1);
      if (end < segment.text.length && last >= 0xd800 && last <= 0xdbff) end--;
      if (end === offset) {
        windows.push([]);
        windowCharacters = 0;
        continue;
      }
      window.push({ text: segment.text.slice(offset, end), classes: segment.classes });
      windowCharacters += end - offset;
      offset = end;
    }
  }
  return {
    text: segments.map((segment) => segment.text).join(""),
    windows,
    ansiState: parsed.state,
  };
}
