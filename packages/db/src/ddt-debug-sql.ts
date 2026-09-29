import {
  DomainError,
  ddtCaseCell,
  isDdtJourney,
  type DdtCase,
  type DdtCaseSummary,
} from "@autoforge/domain";
import type { DdtDebugScope, DdtDebugWrite, DdtImportCaseOutcome } from "@autoforge/application";
import { ddtCaseDataSchema } from "@autoforge/contracts";
export const debugScopeWhere =
  "project_id = ? AND project_version_id = ? AND test_stage_id = ? AND owner_user_id = ?";
export function debugScopeValues(scope: DdtDebugScope) {
  return [scope.projectId, scope.projectVersionId, scope.testStageId, scope.ownerUserId];
}
export type DebugCaseRow = {
  id: string;
  project_id: string;
  project_version_id: string;
  test_stage_id: string;
  owner_user_id: string;
  case_id: string;
  case_id_normalized: string;
  data_json: string;
  source_name: string;
  revision: number;
  created_at: string;
  updated_at: string;
};
export function mapDebugCase(row: DebugCaseRow): DdtCase {
  const data = ddtCaseDataSchema.parse(JSON.parse(row.data_json));
  return {
    id: row.id,
    projectId: row.project_id,
    projectVersionId: row.project_version_id,
    testStageId: row.test_stage_id,
    caseId: row.case_id,
    srNum: String(ddtCaseCell(data, "srNum")),
    kind: isDdtJourney(data) ? "journey" : "standard",
    data,
    sourceName: row.source_name,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.owner_user_id,
  };
}
export function debugCasePage(rows: DebugCaseRow[], limit: number) {
  const items: DdtCaseSummary[] = rows.slice(0, limit).map((row) => {
    const item = mapDebugCase(row);
    return {
      id: item.id,
      projectId: item.projectId,
      projectVersionId: item.projectVersionId,
      testStageId: item.testStageId,
      caseId: item.caseId,
      srNum: item.srNum,
      kind: item.kind,
      sourceName: item.sourceName,
      revision: item.revision,
      updatedAt: item.updatedAt,
    };
  });
  return {
    items,
    ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.case_id_normalized } : {}),
  };
}
export function debugWriteOutcome(
  existing: DebugCaseRow | undefined,
  input: DdtDebugWrite,
): DdtImportCaseOutcome {
  if (input.expectedRevision !== undefined && existing?.revision !== input.expectedRevision)
    throw new DomainError("DDT_CASE_CONFLICT", "调试数据已修改或删除，请重新打开后再保存。");
  if (!existing) return "inserted";
  if (JSON.stringify(JSON.parse(existing.data_json)) === JSON.stringify(input.data))
    return "unchanged";
  if (input.strategy === "skip") return "skipped";
  if (input.strategy === "error")
    throw new DomainError("DDT_IMPORT_CONFLICT", `个人调试用例“${input.caseId}”已存在。`);
  return "updated";
}
export const debugCaseUpsert = `INSERT INTO ddt_debug_cases
 (id, project_id, project_version_id, test_stage_id, owner_user_id, case_id, case_id_normalized, data_json, source_name, revision, created_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
 ON CONFLICT(project_id, project_version_id, test_stage_id, owner_user_id, case_id_normalized)
 DO UPDATE SET case_id = excluded.case_id, data_json = excluded.data_json, source_name = excluded.source_name, revision = ddt_debug_cases.revision + 1, updated_at = excluded.updated_at`;
export function debugWriteValues(input: DdtDebugWrite) {
  return [
    input.id,
    ...debugScopeValues(input.scope),
    input.caseId,
    input.caseId.toLocaleLowerCase("en-US"),
    JSON.stringify(input.data),
    input.sourceName,
    input.now,
    input.now,
  ];
}
