import { parseSafeAnsi } from "../src/lib/safe-ansi.ts";

export const AI_INPUT_MAXIMUM_CHARACTERS = 5000;
export const AI_INPUT_TAIL_CHARACTERS = 2500;

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
  return { text: text.slice(start), shortened: true };
}

export function prepareAiText(text: string) {
  const plain = parseSafeAnsi(text)
    .map((segment) => segment.text)
    .join("");
  return shortenAiInput(redactAiText(plain));
}

/** Apply to the complete value before selecting a tail so its secret prefix cannot be lost. */
export function redactAiText(value: string) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(
      /((?:password|passwd|secret|api[_-]?key|authorization|access[_-]?token)\s*["']?\s*[:=]\s*["']?)([^\s,"'}]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/:]+:[^\s/@]+@/giu, "$1[REDACTED]@");
}

export function redactAiJson(value: unknown, onShortened?: () => void) {
  return JSON.stringify(value, (key, cell: unknown) => {
    if (
      /(?:password|passwd|secret|api[_-]?key|authorization|access[_-]?token|cookie|private[_-]?key)/iu.test(
        key,
      )
    )
      return "[REDACTED]";
    if (typeof cell !== "string") return cell;
    const prepared = prepareAiText(cell);
    if (prepared.shortened) onShortened?.();
    return prepared.text;
  });
}
