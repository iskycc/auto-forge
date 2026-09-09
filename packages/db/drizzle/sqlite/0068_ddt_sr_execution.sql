CREATE TABLE ddt_execution_configuration (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  test_stage_id TEXT NOT NULL REFERENCES test_stages(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, project_version_id, test_stage_id)
);
CREATE TABLE ddt_execution_class_range (
  project_id TEXT NOT NULL,
  project_version_id TEXT NOT NULL,
  test_stage_id TEXT NOT NULL,
  execution_case_definition_id TEXT NOT NULL REFERENCES case_definitions(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, project_version_id, test_stage_id, execution_case_definition_id),
  FOREIGN KEY (project_id, project_version_id, test_stage_id)
    REFERENCES ddt_execution_configuration(project_id, project_version_id, test_stage_id) ON DELETE CASCADE
);
CREATE TABLE ddt_sr_execution_mappings (
  project_id TEXT NOT NULL,
  project_version_id TEXT NOT NULL,
  test_stage_id TEXT NOT NULL,
  sr_num_normalized TEXT NOT NULL,
  sr_num TEXT NOT NULL,
  execution_case_definition_id TEXT REFERENCES case_definitions(id) ON DELETE SET NULL,
  legacy_conflict INTEGER NOT NULL DEFAULT 0 CHECK (legacy_conflict IN (0, 1)),
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, project_version_id, test_stage_id, sr_num_normalized),
  FOREIGN KEY (project_id, project_version_id, test_stage_id)
    REFERENCES ddt_execution_configuration(project_id, project_version_id, test_stage_id) ON DELETE CASCADE
);
CREATE INDEX ddt_sr_execution_class_idx ON ddt_sr_execution_mappings(execution_case_definition_id);

-- Keep the old per-case columns as upgrade evidence. New reads never fall back to them.
WITH legacy_cases AS (
 SELECT project_id, project_version_id, test_stage_id, sr_num_normalized, sr_num,
   execution_case_definition_id, updated_at FROM ddt_cases
 UNION ALL
 SELECT project_id, project_version_id, test_stage_id, sr_num_normalized, sr_num,
   execution_case_definition_id, case_updated_at AS updated_at FROM ddt_deleted_cases
)
INSERT INTO ddt_execution_configuration (project_id, project_version_id, test_stage_id, revision)
SELECT DISTINCT project_id, project_version_id, test_stage_id, 1
FROM legacy_cases WHERE execution_case_definition_id IS NOT NULL;
WITH legacy_cases AS (
 SELECT project_id, project_version_id, test_stage_id, sr_num_normalized, sr_num,
   execution_case_definition_id, updated_at FROM ddt_cases
 UNION ALL
 SELECT project_id, project_version_id, test_stage_id, sr_num_normalized, sr_num,
   execution_case_definition_id, case_updated_at AS updated_at FROM ddt_deleted_cases
)
INSERT INTO ddt_execution_class_range
SELECT DISTINCT project_id, project_version_id, test_stage_id, execution_case_definition_id
FROM legacy_cases WHERE execution_case_definition_id IS NOT NULL;
WITH legacy_cases AS (
 SELECT project_id, project_version_id, test_stage_id, sr_num_normalized, sr_num,
   execution_case_definition_id, updated_at FROM ddt_cases
 UNION ALL
 SELECT project_id, project_version_id, test_stage_id, sr_num_normalized, sr_num,
   execution_case_definition_id, case_updated_at AS updated_at FROM ddt_deleted_cases
)
INSERT INTO ddt_sr_execution_mappings
  (project_id, project_version_id, test_stage_id, sr_num_normalized, sr_num,
   execution_case_definition_id, legacy_conflict, revision, updated_at)
SELECT project_id, project_version_id, test_stage_id, sr_num_normalized, MIN(sr_num),
  CASE WHEN COUNT(DISTINCT execution_case_definition_id) = 1 THEN MIN(execution_case_definition_id) ELSE NULL END,
  CASE WHEN COUNT(DISTINCT execution_case_definition_id) > 1 THEN 1 ELSE 0 END,
  1, MAX(updated_at)
FROM legacy_cases
GROUP BY project_id, project_version_id, test_stage_id, sr_num_normalized
HAVING COUNT(execution_case_definition_id) > 0;
