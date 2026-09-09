import {
  DomainError,
  type DdtExecutionClass,
  type DdtSrExecutionMapping,
  type DdtRequirementCategory,
} from "@autoforge/domain";

/** Resolve the SR at read/snapshot time so imports and SR edits inherit without fan-out writes. */
export const ddtExecutionClassIdSql = `(SELECT CASE WHEN mapping.category_id IS NOT NULL THEN category.execution_case_definition_id ELSE mapping.execution_case_definition_id END
  FROM ddt_sr_execution_mappings mapping
  LEFT JOIN ddt_requirement_categories category ON category.id = mapping.category_id
    AND category.project_id = mapping.project_id AND category.project_version_id = mapping.project_version_id AND category.test_stage_id = mapping.test_stage_id
  WHERE mapping.project_id = ddt_cases.project_id
    AND mapping.project_version_id = ddt_cases.project_version_id
    AND mapping.test_stage_id = ddt_cases.test_stage_id
    AND mapping.sr_num_normalized = ddt_cases.sr_num_normalized)`;

export const ddtRequirementCategoryIdSql = `(SELECT mapping.category_id FROM ddt_sr_execution_mappings mapping
  WHERE mapping.project_id = ddt_cases.project_id AND mapping.project_version_id = ddt_cases.project_version_id
    AND mapping.test_stage_id = ddt_cases.test_stage_id AND mapping.sr_num_normalized = ddt_cases.sr_num_normalized)`;

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
  categoryId: string | null;
  categoryName: string | null;
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
    ...(row.categoryId ? { category: { id: row.categoryId, name: row.categoryName! } } : {}),
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
    requirementCategoryId?: string | null;
    executionCaseDefinitionId: string | null;
  },
>(rows: Row[]): Row[] {
  const mappingIds = new Map<string, string | null>();
  const categoryClassIds = new Map<string, string | null>();
  return rows.map((row) => {
    const key = JSON.stringify([
      row.projectId,
      row.projectVersionId,
      row.testStageId,
      row.srNumNormalized,
    ]);
    if (!mappingIds.has(key)) {
      const categoryKey = row.requirementCategoryId
        ? JSON.stringify([
            row.projectId,
            row.projectVersionId,
            row.testStageId,
            row.requirementCategoryId,
          ])
        : null;
      if (categoryKey && !categoryClassIds.has(categoryKey))
        categoryClassIds.set(categoryKey, row.executionCaseDefinitionId);
      mappingIds.set(
        key,
        categoryKey ? categoryClassIds.get(categoryKey)! : row.executionCaseDefinitionId,
      );
    }
    return { ...row, executionCaseDefinitionId: mappingIds.get(key)! };
  });
}

export type DdtRequirementCategoryRow = Omit<DdtExecutionClassRow, "caseDefinitionId"> & {
  id: string;
  name: string;
  revision: number;
  caseDefinitionId: string | null;
};
export function mapDdtRequirementCategory(row: DdtRequirementCategoryRow): DdtRequirementCategory {
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    ...(row.caseDefinitionId
      ? { executionClass: mapDdtExecutionClass({ ...row, caseDefinitionId: row.caseDefinitionId }) }
      : {}),
  };
}
