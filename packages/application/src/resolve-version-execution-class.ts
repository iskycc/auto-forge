import { DomainError, type DdtScope } from "@autoforge/domain";
import type { CaseCatalogRepository } from "./ports";

export async function resolveVersionExecutionClass(
  catalog: Pick<CaseCatalogRepository, "findCaseDefinitionIdsByClassName">,
  versionScope: Pick<DdtScope, "projectId" | "projectVersionId">,
  testStageIds: readonly string[],
  className: string,
): Promise<{ caseDefinitionId: string; testStageId: string }> {
  let match: { caseDefinitionId: string; testStageId: string } | undefined;
  for (const testStageId of testStageIds) {
    const ids = await catalog.findCaseDefinitionIdsByClassName(
      { ...versionScope, testStageId },
      className,
    );
    if (ids.length > 1) {
      throw new DomainError(
        "CASE_CLASS_SCOPE_CONFLICT",
        "当前测试阶段存在多条相同类路径的用例，请先整理重复用例，或使用 caseDefinitionId 精确指定。",
      );
    }
    if (!ids.length) continue;
    if (match) {
      throw new DomainError(
        "CASE_CLASS_SCOPE_CONFLICT",
        "该类路径在当前版本的多个有效阶段中存在，请使用带 /stages/{stageId}/ 的接口 URL 指定测试阶段。",
      );
    }
    match = { caseDefinitionId: ids[0]!, testStageId };
  }
  if (!match)
    throw new DomainError(
      "CASE_DEFINITION_NOT_FOUND",
      "当前版本及所选有效阶段中不存在该完整类路径的可用用例。",
    );
  return match;
}
