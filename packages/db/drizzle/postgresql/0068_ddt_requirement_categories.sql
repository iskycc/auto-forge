CREATE TABLE ddt_requirement_categories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_version_id TEXT NOT NULL,
  test_stage_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  execution_case_definition_id TEXT REFERENCES case_definitions(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id, project_version_id, test_stage_id) REFERENCES ddt_execution_configuration(project_id, project_version_id, test_stage_id) ON DELETE CASCADE,
  UNIQUE (project_id, project_version_id, test_stage_id, normalized_name)
);
ALTER TABLE ddt_sr_execution_mappings ADD COLUMN category_id TEXT REFERENCES ddt_requirement_categories(id);
CREATE INDEX ddt_sr_category_idx ON ddt_sr_execution_mappings(category_id);
CREATE INDEX ddt_category_class_idx ON ddt_requirement_categories(execution_case_definition_id);

-- Preserve existing uniform mappings as editable categories; ambiguous SRs remain unassigned.
-- Case definition IDs are globally unique and already identify one version/stage scope.
INSERT INTO ddt_requirement_categories (id, project_id, project_version_id, test_stage_id, name, normalized_name, execution_case_definition_id, revision, updated_at)
SELECT execution_case_definition_id, project_id, project_version_id, test_stage_id,
       '历史分类 · ' || execution_case_definition_id, '历史分类 · ' || execution_case_definition_id,
       execution_case_definition_id, 1, MAX(updated_at)
FROM ddt_sr_execution_mappings WHERE execution_case_definition_id IS NOT NULL
GROUP BY execution_case_definition_id, project_id, project_version_id, test_stage_id;
UPDATE ddt_sr_execution_mappings SET category_id = execution_case_definition_id
WHERE execution_case_definition_id IS NOT NULL;
UPDATE ddt_sr_execution_mappings SET execution_case_definition_id = NULL WHERE category_id IS NOT NULL;
