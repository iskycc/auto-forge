CREATE TABLE case_suite_member_changes (
  id TEXT PRIMARY KEY NOT NULL,
  suite_id TEXT NOT NULL REFERENCES case_suites(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('standard', 'ddt')),
  operation TEXT NOT NULL CHECK (operation IN ('add', 'remove')),
  member_count INTEGER NOT NULL CHECK (member_count > 0),
  actor_id TEXT,
  actor_name TEXT,
  remark TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

CREATE INDEX case_suite_member_changes_suite_idx ON case_suite_member_changes (suite_id, id DESC);

CREATE TABLE case_suite_member_change_items (
  change_id TEXT NOT NULL REFERENCES case_suite_member_changes(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  case_label TEXT NOT NULL,
  PRIMARY KEY (change_id, case_id)
);

CREATE TABLE case_suite_standard_markers (
  member_id TEXT PRIMARY KEY NOT NULL REFERENCES case_suite_items(id) ON DELETE CASCADE,
  markers_json TEXT NOT NULL
);

CREATE TABLE case_suite_ddt_markers (
  member_id TEXT PRIMARY KEY NOT NULL REFERENCES case_suite_ddt_items(id) ON DELETE CASCADE,
  markers_json TEXT NOT NULL
);

CREATE TABLE execution_run_suite_markers (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  markers_json TEXT NOT NULL
);

CREATE INDEX execution_run_suite_markers_batch_idx ON execution_run_suite_markers (batch_id, run_id);
