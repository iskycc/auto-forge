CREATE TABLE webhook_configurations (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  target_url TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('GET', 'POST')),
  body_template TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  enabled_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((method = 'GET' AND body_template IS NULL) OR (method = 'POST' AND body_template IS NOT NULL))
);

CREATE UNIQUE INDEX webhook_configurations_project_name_uq
  ON webhook_configurations(project_id, normalized_name) WHERE deleted_at IS NULL;
CREATE INDEX webhook_configurations_project_idx
  ON webhook_configurations(project_id, created_at);

CREATE TABLE case_suite_webhook_bindings (
  suite_id TEXT NOT NULL REFERENCES case_suites(id) ON DELETE CASCADE,
  webhook_id TEXT NOT NULL REFERENCES webhook_configurations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (suite_id, webhook_id)
);

CREATE INDEX case_suite_webhook_bindings_webhook_idx
  ON case_suite_webhook_bindings(webhook_id, suite_id);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  webhook_id TEXT NOT NULL REFERENCES webhook_configurations(id) ON DELETE RESTRICT,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  webhook_name TEXT NOT NULL,
  request_url TEXT NOT NULL,
  request_method TEXT NOT NULL CHECK (request_method IN ('GET', 'POST')),
  request_body_template TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  response_status INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (webhook_id, batch_id)
);

CREATE INDEX webhook_deliveries_due_idx
  ON webhook_deliveries(status, available_at, lease_expires_at);
CREATE INDEX webhook_deliveries_webhook_created_idx
  ON webhook_deliveries(webhook_id, created_at);
