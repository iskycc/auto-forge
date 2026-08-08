CREATE TABLE case_sources (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  class_count INTEGER NOT NULL CHECK (class_count >= 0),
  method_count INTEGER NOT NULL CHECK (method_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
  warnings_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX case_sources_sha256_uq ON case_sources (sha256);
CREATE UNIQUE INDEX case_sources_object_key_uq ON case_sources (object_key);
CREATE INDEX case_sources_created_at_idx ON case_sources (created_at);

CREATE TABLE case_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES case_sources(id) ON DELETE CASCADE,
  class_name TEXT NOT NULL,
  package_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  groups_json TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX case_definitions_source_class_uq
  ON case_definitions (source_id, class_name);
CREATE INDEX case_definitions_class_name_idx ON case_definitions (class_name);

CREATE TABLE case_versions (
  id TEXT PRIMARY KEY NOT NULL,
  case_definition_id TEXT NOT NULL REFERENCES case_definitions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX case_versions_definition_version_uq
  ON case_versions (case_definition_id, version);

CREATE TABLE test_methods (
  id TEXT PRIMARY KEY NOT NULL,
  case_definition_id TEXT NOT NULL REFERENCES case_definitions(id) ON DELETE CASCADE,
  method_name TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  annotation_source TEXT NOT NULL CHECK (annotation_source IN ('method', 'class')),
  groups_json TEXT NOT NULL,
  description TEXT,
  data_provider TEXT,
  depends_on_methods_json TEXT NOT NULL,
  depends_on_groups_json TEXT NOT NULL,
  priority INTEGER,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX test_methods_definition_method_descriptor_uq
  ON test_methods (case_definition_id, method_name, descriptor);
CREATE INDEX test_methods_definition_idx ON test_methods (case_definition_id);
