import type { RunBatchListQuery } from "@autoforge/application";

export function runBatchFilterFromSearch(
  parameters: Record<string, string | string[] | undefined>,
  projectIds: string[] | undefined,
): RunBatchListQuery {
  const value = (key: string) =>
    typeof parameters[key] === "string" && parameters[key]
      ? (parameters[key] as string)
      : undefined;
  const date = (key: string) => {
    const raw = value(key);
    if (!raw) return undefined;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  };
  const status = value("status");
  const cursor = value("cursor");
  const projectId = value("projectId");
  const suiteId = value("suiteId");
  const caseDefinitionId = value("caseDefinitionId");
  const runnerId = value("runnerId");
  const createdAfter = date("createdAfter");
  const createdBefore = date("createdBefore");
  const normalizedStatus =
    status && ["queued", "running", "succeeded", "failed", "cancelled"].includes(status)
      ? (status as NonNullable<RunBatchListQuery["status"]>)
      : undefined;
  return {
    limit: 50,
    ...(projectIds ? { projectIds } : {}),
    ...(cursor ? { cursor } : {}),
    ...(projectId ? { projectId } : {}),
    ...(suiteId ? { suiteId } : {}),
    ...(caseDefinitionId ? { caseDefinitionId } : {}),
    ...(runnerId ? { runnerId } : {}),
    ...(createdAfter ? { createdAfter } : {}),
    ...(createdBefore ? { createdBefore } : {}),
    ...(normalizedStatus ? { status: normalizedStatus } : {}),
  };
}

export function refreshQueryFromFilter(filter: RunBatchListQuery): URLSearchParams {
  const refreshQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (key !== "projectIds" && value !== undefined) refreshQuery.set(key, String(value));
  }
  return refreshQuery;
}

export function localDateTimeInputValue(value: string | undefined): string {
  return value ? value.slice(0, 16) : "";
}
