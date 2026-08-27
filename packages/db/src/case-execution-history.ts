import { DomainError } from "@autoforge/domain";

const CURSOR_SEPARATOR = "|";

export type CaseExecutionHistoryCursor = { createdAt: string; runId: string };

export function encodeCaseExecutionHistoryCursor(cursor: CaseExecutionHistoryCursor): string {
  return Buffer.from(`${cursor.createdAt}${CURSOR_SEPARATOR}${cursor.runId}`, "utf8").toString(
    "base64url",
  );
}

export function decodeCaseExecutionHistoryCursor(
  value: string | undefined,
): CaseExecutionHistoryCursor | undefined {
  if (!value) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.indexOf(CURSOR_SEPARATOR);
    if (separator <= 0 || separator === decoded.length - 1) throw new Error("invalid cursor");
    const createdAt = decoded.slice(0, separator);
    const runId = decoded.slice(separator + 1);
    if (Number.isNaN(Date.parse(createdAt)) || runId.length > 128) {
      throw new Error("invalid cursor values");
    }
    return { createdAt, runId };
  } catch (error) {
    throw new DomainError("CASE_EXECUTION_CURSOR_INVALID", "用例执行历史分页游标无效。", {
      cause: error instanceof Error ? error : undefined,
    });
  }
}
