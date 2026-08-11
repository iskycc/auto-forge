export type AnsiSegment = {
  text: string;
  classes: string[];
};

type StyleState = { bold: boolean; foreground?: string };

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
  const segments: AnsiSegment[] = [];
  const style: StyleState = { bold: false };
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
      const operatingSystemCommandEnd = readOscEnd(input, index);
      if (operatingSystemCommandEnd !== undefined) {
        index = operatingSystemCommandEnd;
        continue;
      }
      const sequence = readControlSequence(input, index);
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
  return segments;
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
  for (const code of codes) {
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
