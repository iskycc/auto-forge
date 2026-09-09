import { DomainError, type DdtExecutionClass, type DdtSrExecutionMapping } from "@autoforge/domain";

/** Resolve the SR at read/snapshot time so imports and SR edits inherit without fan-out writes. */
export const ddtExecutionClassIdSql = `(SELECT mapping.execution_case_definition_id
  FROM ddt_sr_execution_mappings mapping
  WHERE mapping.project_id = ddt_cases.project_id
    AND mapping.project_version_id = ddt_cases.project_version_id
    AND mapping.test_stage_id = ddt_cases.test_stage_id
    AND mapping.sr_num_normalized = ddt_cases.sr_num_normalized)`;

export type DdtExecutionClassRow = Omit<DdtExecutionClass, "enabled" | "archived"> & {
  enabled: number;
  archived: number;
};
export type DdtSrMappingRow = Omit<DdtExecutionClassRow, "caseDefinitionId"> & {
  caseDefinitionId: string | null;
  cursor: string;
  srNum: string;
  caseCount: number | string;
  revision: number;
  legacyConflict: number;
};
export function mapDdtExecutionClass(row: DdtExecutionClassRow): DdtExecutionClass {
  return {
    caseDefinitionId: row.caseDefinitionId,
    className: row.className,
    displayName: row.displayName,
    sourceId: row.sourceId,
    currentVersion: row.currentVersion,
    enabled: Boolean(row.enabled),
    archived: Boolean(row.archived),
  };
}
export function mapDdtSrMapping(row: DdtSrMappingRow): DdtSrExecutionMapping {
  return {
    srNum: row.srNum,
    caseCount: Number(row.caseCount),
    revision: row.revision,
    legacyConflict: Boolean(row.legacyConflict),
    ...(row.caseDefinitionId
      ? {
          executionClass: mapDdtExecutionClass({ ...row, caseDefinitionId: row.caseDefinitionId }),
        }
      : {}),
  };
}
export function ddtMappingConflict() {
  return new DomainError(
    "DDT_EXECUTION_MAPPING_REVISION_CONFLICT",
    "SR 关联或测试类范围已被修改，请刷新后重试。",
  );
}

/** A suite may be read in several SQL windows. Freeze the first observed SR mapping for this read. */
export function freezeDdtSrExecutionClasses<
  Row extends {
    projectId: string;
    projectVersionId: string;
    testStageId: string;
    srNumNormalized: string;
    executionCaseDefinitionId: string | null;
  },
>(rows: Row[]): Row[] {
  const mappingIds = new Map<string, string | null>();
  return rows.map((row) => {
    const key = JSON.stringify([
      row.projectId,
      row.projectVersionId,
      row.testStageId,
      row.srNumNormalized,
    ]);
    if (!mappingIds.has(key)) mappingIds.set(key, row.executionCaseDefinitionId);
    return { ...row, executionCaseDefinitionId: mappingIds.get(key)! };
  });
}
