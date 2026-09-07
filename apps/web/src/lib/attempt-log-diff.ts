import { visibleAttemptLogText } from "./log-presentation";
import { parseSafeAnsi } from "./safe-ansi";

export const MAXIMUM_COMPARISON_CHARACTERS = 128 * 1024;
export const MAXIMUM_COMPARISON_LINES = 2_000;

type LogLine = { number: number; text: string };
export type LogDiffRow = {
  kind: "equal" | "changed" | "added" | "removed";
  previous?: LogLine;
  current?: LogLine;
};

function comparisonLines(text: string) {
  const visible = parseSafeAnsi(visibleAttemptLogText(text.slice(0, MAXIMUM_COMPARISON_CHARACTERS)))
    .map((segment) => segment.text)
    .join("")
    .replace(/\r\n?/gu, "\n");
  const lines = visible ? visible.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  return {
    lines: lines.slice(0, MAXIMUM_COMPARISON_LINES),
    limited: text.length > MAXIMUM_COMPARISON_CHARACTERS || lines.length > MAXIMUM_COMPARISON_LINES,
  };
}

export function compareAttemptLogs(
  previousText: string,
  currentText: string,
): {
  rows: LogDiffRow[];
  limited: boolean;
} {
  const previous = comparisonLines(previousText);
  const current = comparisonLines(currentText);
  const left = previous.lines;
  const right = current.lines;
  const stride = right.length + 1;
  // 输入先限制到 2,000 行，LCS 最多比较四百万对行，矩阵不超过约 8 MiB。
  const matches = new Uint16Array((left.length + 1) * stride);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      matches[i * stride + j] =
        left[i] === right[j]
          ? matches[(i + 1) * stride + j + 1]! + 1
          : Math.max(matches[(i + 1) * stride + j]!, matches[i * stride + j + 1]!);
    }
  }
  const rows: LogDiffRow[] = [];
  let removed: LogLine[] = [];
  let added: LogLine[] = [];
  const flushChanges = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index += 1) {
      const previousLine = removed[index];
      const currentLine = added[index];
      rows.push({
        kind: previousLine && currentLine ? "changed" : previousLine ? "removed" : "added",
        ...(previousLine ? { previous: previousLine } : {}),
        ...(currentLine ? { current: currentLine } : {}),
      });
    }
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      flushChanges();
      rows.push({
        kind: "equal",
        previous: { number: i + 1, text: left[i]! },
        current: { number: j + 1, text: right[j]! },
      });
      i += 1;
      j += 1;
    } else if (
      i < left.length &&
      (j === right.length || matches[(i + 1) * stride + j]! >= matches[i * stride + j + 1]!)
    ) {
      removed.push({ number: i + 1, text: left[i++]! });
    } else {
      added.push({ number: j + 1, text: right[j++]! });
    }
  }
  flushChanges();
  return { rows, limited: previous.limited || current.limited };
}
