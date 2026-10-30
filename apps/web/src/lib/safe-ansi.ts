export type AnsiSegment = {
  text: string;
  classes: string[];
};

type StyleState = { bold: boolean; foreground?: string };
export type AnsiParserState = StyleState & { pending?: string };

const ANSI_COLORS: Record<number, string> = {
  30: "black",
  31: "red",
  32: "green",
  33: "yellow",
  34: "blue",
  35: "magenta",
  36: "cyan",
  37: "white",
  90: "bright-black",
  91: "bright-red",
  92: "bright-green",
  93: "bright-yellow",
  94: "bright-blue",
  95: "bright-magenta",
  96: "bright-cyan",
  97: "bright-white",
};

const MAXIMUM_CONTROL_SEQUENCE_LENGTH = 64;
const MAXIMUM_SEGMENTS = 10_000;

export function parseSafeAnsi(input: string): AnsiSegment[] {
  return parseSafeAnsiStream(input).segments;
}

/** Page boundaries are transport boundaries, not terminal resets. State stays bounded. */
export function parseSafeAnsiStream(
  content: string,
  previous?: AnsiParserState,
): { segments: AnsiSegment[]; state: AnsiParserState } {
  const input = ((previous?.pending ?? "") + content).replace(/\u009b/g, "\u001b[");
  const segments: AnsiSegment[] = [];
  const style: StyleState = {
    bold: previous?.bold ?? false,
    ...(previous?.foreground ? { foreground: previous.foreground } : {}),
  };
  let pending: string | undefined;
  let text = "";
  const flush = () => {
    if (!text) return;
    const classes = [
      ...(style.bold ? ["ansi-bold"] : []),
      ...(style.foreground ? [`ansi-${style.foreground}`] : []),
    ];
    const previous = segments.at(-1);
    if (previous && previous.classes.join(" ") === classes.join(" ")) previous.text += text;
    else if (segments.length < MAXIMUM_SEGMENTS) segments.push({ text, classes });
    else segments[segments.length - 1]!.text += text;
    text = "";
  };

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 0x1b) {
      if (index === input.length - 1) {
        pending = "\u001b";
        break;
      }
      const operatingSystemCommandEnd = readOscEnd(input, index);
      if (operatingSystemCommandEnd !== undefined) {
        if (
          operatingSystemCommandEnd === input.length - 1 &&
          input.length - index < 2048 &&
          input.charCodeAt(operatingSystemCommandEnd) !== 0x07 &&
          !(
            input[operatingSystemCommandEnd] === "\\" &&
            input.charCodeAt(operatingSystemCommandEnd - 1) === 0x1b
          )
        ) {
          pending = input.slice(index);
          break;
        }
        index = operatingSystemCommandEnd;
        continue;
      }
      const sequence = readControlSequence(input, index);
      if (
        !sequence &&
        input[index + 1] === "[" &&
        input.length - index < MAXIMUM_CONTROL_SEQUENCE_LENGTH
      ) {
        pending = input.slice(index);
        break;
      }
      if (sequence) {
        flush();
        if (sequence.final === "m") applySgr(style, sequence.parameters);
        index = sequence.end;
      }
      continue;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code === 0x7f) continue;
    text += input[index];
  }
  flush();
  return { segments, state: { ...style, ...(pending ? { pending } : {}) } };
}

function readOscEnd(input: string, escapeIndex: number): number | undefined {
  if (input[escapeIndex + 1] !== "]") return undefined;
  const maximum = Math.min(input.length, escapeIndex + 2_048);
  for (let index = escapeIndex + 2; index < maximum; index += 1) {
    if (input.charCodeAt(index) === 0x07) return index;
    if (input.charCodeAt(index) === 0x1b && input[index + 1] === "\\") return index + 1;
  }
  return maximum - 1;
}

function readControlSequence(
  input: string,
  escapeIndex: number,
): { parameters: string; final: string; end: number } | undefined {
  if (input[escapeIndex + 1] !== "[") return undefined;
  const maximum = Math.min(input.length, escapeIndex + MAXIMUM_CONTROL_SEQUENCE_LENGTH);
  for (let index = escapeIndex + 2; index < maximum; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return {
        parameters: input.slice(escapeIndex + 2, index),
        final: input[index]!,
        end: index,
      };
    }
  }
  return undefined;
}

function applySgr(style: StyleState, parameters: string): void {
  const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index]!;
    // Extended colors are unsupported rather than arbitrary CSS. Their RGB/index
    // payload must never be interpreted as bold/reset/basic-color instructions.
    if (code === 38 || code === 48 || code === 58) {
      if (codes[index + 1] === 2) index += 4;
      else if (codes[index + 1] === 5) index += 2;
      continue;
    }
    if (!Number.isInteger(code)) continue;
    if (code === 0) {
      style.bold = false;
      delete style.foreground;
    } else if (code === 1) style.bold = true;
    else if (code === 22) style.bold = false;
    else if (code === 39) delete style.foreground;
    else if (ANSI_COLORS[code]) style.foreground = ANSI_COLORS[code];
  }
}
