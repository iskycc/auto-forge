const CURSOR_SEPARATOR = "|";

export type RunBatchCursor = { createdAt: string; id: string };

export function encodeRunBatchCursor(cursor: RunBatchCursor): string {
  return Buffer.from(`${cursor.createdAt}${CURSOR_SEPARATOR}${cursor.id}`, "utf8").toString(
    "base64url",
  );
}

export function decodeRunBatchCursor(value: string | undefined): RunBatchCursor | undefined {
  if (!value) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.indexOf(CURSOR_SEPARATOR);
    if (separator <= 0 || separator === decoded.length - 1) return undefined;
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(new Date(createdAt).getTime()) || id.length > 128) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}
