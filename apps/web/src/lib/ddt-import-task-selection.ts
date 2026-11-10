import {
  addCaseSuiteDdtItemsInputSchema,
  ddtImportCaseIdsSchema,
  type DdtImportJobSummary,
} from "@autoforge/contracts";

export function canAddDdtImportToTask(
  job: Pick<
    DdtImportJobSummary,
    "status" | "insertedCount" | "updatedCount" | "unchangedCount" | "skippedCount"
  >,
): boolean {
  return (
    ["succeeded", "partially_succeeded", "failed", "cancelled"].includes(job.status) &&
    job.insertedCount + job.updatedCount + job.unchangedCount + job.skippedCount > 0
  );
}

/** The import ledger contains only committed rows, including existing cases kept by skip policy. */
export function ddtImportTaskCaseIds(response: unknown): string[] {
  const { items } = ddtImportCaseIdsSchema.parse(response);
  const caseIds = [...new Set(items.map((item) => item.caseId))];
  if (!caseIds.length) throw new Error("本次导入没有可加入任务的 CaseID。");
  const invalid = caseIds.find(
    (caseId) => !addCaseSuiteDdtItemsInputSchema.shape.caseIds.element.safeParse(caseId).success,
  );
  if (invalid)
    throw new Error(
      `CaseID“${invalid.slice(0, 80)}${invalid.length > 80 ? "…" : ""}”超出任务接口支持的格式，请检查对应源用例。`,
    );
  return caseIds;
}
