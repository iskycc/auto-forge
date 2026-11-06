import { parseSafeAnsi } from "../src/lib/safe-ansi.ts";

export const AI_INPUT_MAXIMUM_CHARACTERS = 50000;
export const AI_INPUT_TAIL_CHARACTERS = 25000;

/** The Adapter's generic process summary is not evidence of the underlying failure. */
export function removeTestNgExitSummaries(text: string): string {
  return text.replace(
    /^[\t ]*TestNG[\t ]+(?:exit[\t ]+(?:code|status)[\t ]*[:：][\t ]*|exited[\t ]+with[\t ]+code[\t ]+)[+-]?\d+\.?[\t ]*(?:\r?\n|$)/gimu,
    "",
  );
}

/** Count Unicode code points; slicing a surrogate pair would corrupt a log character. */
export function shortenAiInput(text: string): { text: string; shortened: boolean } {
  if (text.length <= AI_INPUT_MAXIMUM_CHARACTERS) return { text, shortened: false };
  const characters = text[Symbol.iterator]();
  for (let count = 0; count <= AI_INPUT_MAXIMUM_CHARACTERS; count++) {
    if (characters.next().done) return { text, shortened: false };
  }
  let start = text.length;
  for (let kept = 0; kept < AI_INPUT_TAIL_CHARACTERS; kept++) {
    start--;
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff && start > 0) {
      const previous = text.charCodeAt(start - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) start--;
    }
  }
  // Treat CRLF as one separator; a cut between its characters belongs to the preceding line.
  if (text[start] === "\n" && text[start - 1] === "\r") start--;
  const lineStart =
    Math.max(text.lastIndexOf("\n", start - 1), text.lastIndexOf("\r", start - 1)) + 1;
  return { text: text.slice(lineStart), shortened: lineStart > 0 };
}

export function prepareAiText(text: string) {
  const plain = parseSafeAnsi(text)
    .map((segment) => segment.text)
    .join("");
  return shortenAiInput(plain);
}

/** Prepare only string values; execution data is not masked again during AI collection. */
export function prepareAiJson(value: unknown, onShortened?: () => void) {
  return JSON.stringify(value, (_key, cell: unknown) => {
    if (typeof cell !== "string") return cell;
    const prepared = prepareAiText(cell);
    if (prepared.shortened) onShortened?.();
    return prepared.text;
  });
}
