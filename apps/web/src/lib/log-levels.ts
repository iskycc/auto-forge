import type { AnsiSegment } from "./safe-ansi";

const LOG_LEVEL_PATTERN = /\b(trace|debug|info|warn|warning|error|fatal|severe|critical)\b/gi;
const MAXIMUM_HIGHLIGHT_SEGMENTS = 10_000;

const LEVEL_CLASS_BY_TOKEN: Record<string, string> = {
  trace: "log-level-trace",
  debug: "log-level-debug",
  info: "log-level-info",
  warn: "log-level-warn",
  warning: "log-level-warn",
  error: "log-level-error",
  severe: "log-level-error",
  fatal: "log-level-fatal",
  critical: "log-level-fatal",
};

export function highlightLogLevels(segments: AnsiSegment[]): AnsiSegment[] {
  const output: AnsiSegment[] = [];
  const push = (text: string, classes: string[]) => {
    if (!text) return;
    const key = classes.join(" ");
    const previous = output.at(-1);
    if (previous && previous.classes.join(" ") === key) {
      previous.text += text;
      return;
    }
    // 病态日志可在 512 KiB 内重复数万次 level token；限制 React span 数量，
    // 超限后的文本并入最后一段，内容完整性优先于尾部着色精度。
    if (output.length >= MAXIMUM_HIGHLIGHT_SEGMENTS && previous) {
      previous.text += text;
      return;
    }
    output.push({ text, classes: [...classes] });
  };

  for (const segment of segments) {
    LOG_LEVEL_PATTERN.lastIndex = 0;
    let cursor = 0;
    for (const match of segment.text.matchAll(LOG_LEVEL_PATTERN)) {
      const index = match.index ?? 0;
      const token = match[0];
      const levelClass = LEVEL_CLASS_BY_TOKEN[token.toLowerCase()];
      push(segment.text.slice(cursor, index), segment.classes);
      push(token, levelClass ? [...segment.classes, levelClass] : segment.classes);
      cursor = index + token.length;
    }
    push(segment.text.slice(cursor), segment.classes);
  }
  return output;
}
