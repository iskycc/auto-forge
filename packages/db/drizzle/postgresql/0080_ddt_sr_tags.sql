-- SR tags belong to a version and are shared by every test stage.
CREATE TABLE ddt_sr_tags (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT COLLATE "C" NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, project_version_id, normalized_name),
  UNIQUE(id, project_id, project_version_id)
);
CREATE TABLE ddt_sr_tag_assignments (
  tag_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_version_id TEXT NOT NULL,
  sr_num_normalized TEXT COLLATE "C" NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(tag_id, sr_num_normalized),
  FOREIGN KEY(tag_id, project_id, project_version_id)
    REFERENCES ddt_sr_tags(id, project_id, project_version_id) ON DELETE CASCADE
);
CREATE INDEX ddt_sr_tag_assignments_scope_sr_idx
  ON ddt_sr_tag_assignments(project_id, project_version_id, sr_num_normalized, tag_id);
CREATE INDEX ddt_cases_version_sr_tag_idx
  ON ddt_cases(project_id, project_version_id, sr_num_normalized, sr_num);
