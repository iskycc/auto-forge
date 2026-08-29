ALTER TABLE ddt_cases
  ADD COLUMN execution_case_definition_id TEXT REFERENCES case_definitions(id) ON DELETE SET NULL;

ALTER TABLE ddt_deleted_cases
  ADD COLUMN execution_case_definition_id TEXT REFERENCES case_definitions(id) ON DELETE SET NULL;

CREATE INDEX ddt_cases_execution_class_idx
  ON ddt_cases(execution_case_definition_id);

CREATE TABLE case_suite_ddt_items (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL REFERENCES case_suites(id) ON DELETE CASCADE,
  ddt_case_id TEXT NOT NULL REFERENCES ddt_cases(id) ON DELETE RESTRICT,
  added_at TEXT NOT NULL
);

CREATE UNIQUE INDEX case_suite_ddt_items_suite_case_uq
  ON case_suite_ddt_items(suite_id, ddt_case_id);
CREATE INDEX case_suite_ddt_items_suite_idx ON case_suite_ddt_items(suite_id);

ALTER TABLE execution_runs
  ADD COLUMN case_type TEXT NOT NULL DEFAULT 'testng'
    CHECK (case_type IN ('testng', 'ddt')),
  ADD COLUMN execution_case_definition_id TEXT,
  ADD COLUMN class_data_json TEXT,
  ADD COLUMN class_data_size_bytes INTEGER,
  ADD COLUMN class_data_sha256 TEXT,
  ADD COLUMN ddt_sr_num TEXT;

UPDATE execution_runs
SET execution_case_definition_id = case_definition_id
WHERE execution_case_definition_id IS NULL;

CREATE INDEX execution_runs_execution_class_idx
  ON execution_runs(execution_case_definition_id, case_version);
