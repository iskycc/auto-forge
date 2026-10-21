/** Resolve each SR/category/class only after selecting one bounded summary page. */
export function ddtCaseListPageSql(where: string, limit: string, dialect: "sqlite" | "postgres") {
  const fields = [
    ["id", "id"],
    ["project_id", "projectId"],
    ["project_version_id", "projectVersionId"],
    ["test_stage_id", "testStageId"],
    ["case_id", "caseId"],
    ["case_id_normalized", "caseIdNormalized"],
    ["sr_num", "srNum"],
    ["case_kind", "kind"],
    ["source_name", "sourceName"],
    ["revision", "revision"],
    ["updated_at", "updatedAt"],
  ];
  const executionFields = [
    ["id", "execution_case_definition_id", "executionCaseDefinitionId"],
    ["class_name", "execution_class_name", "executionClassName"],
    ["display_name", "execution_display_name", "executionDisplayName"],
    ["source_id", "execution_source_id", "executionSourceId"],
    ["current_version", "execution_current_version", "executionCurrentVersion"],
    ["enabled", "execution_enabled", "executionEnabled"],
    ["archived", "execution_archived", "executionArchived"],
  ];
  const columns = [
    ...fields.map(
      ([column, name]) => `ddt_cases.${column} AS ${dialect === "sqlite" ? name : column}`,
    ),
    ...executionFields.map(
      ([column, postgresName, sqliteName]) =>
        `execution_class.${column} AS ${dialect === "sqlite" ? sqliteName : postgresName}`,
    ),
  ].join(", ");
  return `WITH ddt_page AS MATERIALIZED (
    SELECT id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized,
      sr_num, sr_num_normalized, case_kind, source_name, revision, updated_at
    FROM ddt_cases WHERE ${where} ORDER BY case_id_normalized LIMIT ${limit}
  ) SELECT ${columns} FROM ddt_page ddt_cases
    LEFT JOIN ddt_sr_execution_mappings mapping ON mapping.project_id = ddt_cases.project_id
      AND mapping.project_version_id = ddt_cases.project_version_id
      AND mapping.test_stage_id = ddt_cases.test_stage_id
      AND mapping.sr_num_normalized = ddt_cases.sr_num_normalized
    LEFT JOIN ddt_requirement_categories category ON category.id = mapping.category_id
      AND category.project_id = mapping.project_id AND category.project_version_id = mapping.project_version_id
      AND category.test_stage_id = mapping.test_stage_id
    LEFT JOIN case_definitions execution_class ON execution_class.id =
      CASE WHEN mapping.category_id IS NOT NULL THEN category.execution_case_definition_id ELSE mapping.execution_case_definition_id END
    ORDER BY ddt_cases.case_id_normalized`;
}
