ALTER TABLE run_batches ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE runners ADD COLUMN draining BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE run_batches ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE run_batches ADD COLUMN cancel_requested_at TEXT;
UPDATE run_batches SET project_id = '00000000-0000-7000-8000-000000000001' WHERE project_id IS NULL;
ALTER TABLE run_batches ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE run_batches ALTER COLUMN project_id SET DEFAULT '00000000-0000-7000-8000-000000000001';

ALTER TABLE execution_runs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE execution_runs ADD COLUMN terminal_outcome TEXT CHECK (terminal_outcome IN ('succeeded', 'failed', 'timed_out', 'cancelled'));
ALTER TABLE execution_runs ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE execution_runs ADD COLUMN queue_deadline_at TEXT;
ALTER TABLE execution_runs ADD COLUMN execution_timeout_ms INTEGER NOT NULL DEFAULT 3600000;

ALTER TABLE run_attempts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE run_attempts ADD COLUMN started_at TEXT;
ALTER TABLE run_attempts ADD COLUMN finished_at TEXT;
ALTER TABLE run_attempts ADD COLUMN outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'timed_out', 'cancelled'));
ALTER TABLE run_attempts ADD COLUMN result_code TEXT;
ALTER TABLE run_attempts ADD COLUMN result_summary TEXT;
ALTER TABLE run_attempts ADD COLUMN completion_digest TEXT;

CREATE TABLE assignments (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
  execution_run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'running', 'completed', 'cancelled', 'expired')),
  priority INTEGER NOT NULL DEFAULT 0,
  execution_spec_json TEXT NOT NULL,
  available_at TEXT NOT NULL,
  claim_deadline_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  cancel_requested_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX assignments_attempt_uq ON assignments (attempt_id);
CREATE INDEX assignments_runner_claim_idx ON assignments (runner_id, status, available_at, priority DESC, created_at);
CREATE INDEX assignments_batch_status_idx ON assignments (batch_id, status);

CREATE TABLE assignment_leases (
  id TEXT PRIMARY KEY NOT NULL,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired', 'revoked')),
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX assignment_leases_token_uq ON assignment_leases (token_hash);
CREATE UNIQUE INDEX assignment_leases_active_assignment_uq ON assignment_leases (assignment_id) WHERE status = 'active';
CREATE INDEX assignment_leases_expiry_idx ON assignment_leases (status, expires_at);

CREATE TABLE assignment_claim_requests (
  runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (runner_id, request_id)
);

CREATE TABLE attempt_completion_receipts (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
  completion_id TEXT NOT NULL UNIQUE,
  result_digest TEXT NOT NULL,
  response_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);

CREATE TABLE attempt_state_events (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  reason_code TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'runner', 'system')),
  actor_id TEXT,
  details_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX attempt_state_events_attempt_idx ON attempt_state_events (attempt_id, recorded_at, id);

CREATE TABLE attempt_log_watermarks (
  attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'agent')),
  acknowledged_sequence BIGINT NOT NULL DEFAULT -1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, stream)
);

CREATE TABLE attempt_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  object_key TEXT,
  media_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL CHECK (status IN ('declared', 'uploaded', 'rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (attempt_id, relative_path)
);
