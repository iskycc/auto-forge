ALTER TABLE runners
  ADD COLUMN cpu_utilization_percent DOUBLE PRECISION,
  ADD COLUMN memory_utilization_percent DOUBLE PRECISION,
  ADD COLUMN load_average_1m DOUBLE PRECISION,
  ADD COLUMN logical_cpu_count INTEGER,
  ADD COLUMN metrics_observed_at TEXT;

CREATE TABLE run_batches (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  suite_name TEXT NOT NULL,
  suite_version INTEGER NOT NULL CHECK (suite_version > 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'dispatching', 'scheduled', 'running', 'succeeded', 'failed', 'cancelled')),
  retry_limit INTEGER NOT NULL CHECK (retry_limit >= 0 AND retry_limit <= 10),
  environment_json TEXT NOT NULL,
  total_runs INTEGER NOT NULL CHECK (total_runs > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX run_batches_status_created_at_idx ON run_batches (status, created_at);
CREATE INDEX run_batches_suite_id_idx ON run_batches (suite_id);

CREATE TABLE run_batch_runners (
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX run_batch_runners_batch_runner_uq ON run_batch_runners (batch_id, runner_id);
CREATE INDEX run_batch_runners_runner_idx ON run_batch_runners (runner_id);

CREATE TABLE execution_runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES run_batches(id) ON DELETE CASCADE,
  case_definition_id TEXT NOT NULL,
  case_version INTEGER NOT NULL CHECK (case_version > 0),
  display_name TEXT NOT NULL,
  class_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'assigned', 'running', 'succeeded', 'failed', 'cancelled')),
  assigned_runner_id TEXT REFERENCES runners(id) ON DELETE RESTRICT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  scheduling_score DOUBLE PRECISION,
  created_at TEXT NOT NULL,
  assigned_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX execution_runs_batch_case_uq ON execution_runs (batch_id, case_definition_id);
CREATE INDEX execution_runs_batch_status_idx ON execution_runs (batch_id, status);
CREATE INDEX execution_runs_runner_status_idx ON execution_runs (assigned_runner_id, status);

CREATE TABLE run_attempts (
  id TEXT PRIMARY KEY,
  execution_run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('assigned', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')),
  scheduling_score DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX run_attempts_run_number_uq ON run_attempts (execution_run_id, attempt_number);
CREATE INDEX run_attempts_runner_status_idx ON run_attempts (runner_id, status);
