ALTER TABLE case_sources ADD COLUMN inspection_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE case_sources ADD COLUMN authoritative INTEGER NOT NULL DEFAULT 0
  CHECK (authoritative IN (0, 1));

CREATE UNIQUE INDEX case_sources_one_authoritative_uq
  ON case_sources (authoritative)
  WHERE authoritative = 1;

CREATE TABLE case_suites (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX case_suites_updated_at_idx ON case_suites (updated_at);

CREATE TABLE case_suite_items (
  id TEXT PRIMARY KEY NOT NULL,
  suite_id TEXT NOT NULL REFERENCES case_suites(id) ON DELETE CASCADE,
  case_definition_id TEXT NOT NULL REFERENCES case_definitions(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL
);

CREATE UNIQUE INDEX case_suite_items_suite_case_uq
  ON case_suite_items (suite_id, case_definition_id);
CREATE INDEX case_suite_items_suite_idx ON case_suite_items (suite_id);

CREATE TABLE runners (
  id TEXT PRIMARY KEY NOT NULL,
  credential_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  os TEXT NOT NULL,
  architecture TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  protocol_version INTEGER NOT NULL CHECK (protocol_version > 0),
  labels_json TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency > 0),
  busy_slots INTEGER NOT NULL CHECK (busy_slots >= 0),
  last_seen_at TEXT NOT NULL,
  shellhub_device_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX runners_credential_hash_uq ON runners (credential_hash);
CREATE INDEX runners_last_seen_at_idx ON runners (last_seen_at);
