CREATE TABLE ddt_change_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  test_stage_id TEXT NOT NULL REFERENCES test_stages(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  case_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewer_id TEXT REFERENCES users(id),
  review_comment TEXT NOT NULL DEFAULT ''
);
CREATE INDEX ddt_change_requests_scope_idx ON ddt_change_requests(project_id, project_version_id, test_stage_id, created_at, id);
CREATE INDEX ddt_change_requests_owner_idx ON ddt_change_requests(project_id, project_version_id, test_stage_id, owner_user_id, created_at, id);
CREATE INDEX ddt_change_requests_status_idx ON ddt_change_requests(project_id, project_version_id, test_stage_id, status, created_at, id);
CREATE TABLE ddt_change_request_items (
  request_id TEXT NOT NULL REFERENCES ddt_change_requests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  case_id TEXT NOT NULL,
  base_id TEXT,
  base_revision INTEGER,
  personal_revision INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  PRIMARY KEY(request_id, position)
);
