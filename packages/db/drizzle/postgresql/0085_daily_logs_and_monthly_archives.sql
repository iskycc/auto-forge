ALTER TABLE log_databases ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(storage_mode IN ('legacy','daily','day'));
ALTER TABLE log_databases ADD COLUMN parent_database_id TEXT REFERENCES log_databases(id);
ALTER TABLE log_databases ADD COLUMN storage_day TEXT;
ALTER TABLE log_databases ADD COLUMN database_prefix TEXT;
ALTER TABLE log_databases ADD COLUMN physical_name TEXT;
ALTER TABLE log_databases ADD COLUMN provisioning_state TEXT NOT NULL DEFAULT 'ready' CHECK(provisioning_state IN ('provisioning','ready','dropped'));
CREATE UNIQUE INDEX log_database_parent_day_uq ON log_databases(parent_database_id,storage_day) WHERE parent_database_id IS NOT NULL;
CREATE UNIQUE INDEX log_database_daily_address_uq ON log_databases(address) WHERE storage_mode='daily';

CREATE TABLE attempt_log_database_routes (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL,
  anchor_database_id TEXT NOT NULL REFERENCES log_databases(id)
);
CREATE INDEX attempt_log_database_routes_batch_idx ON attempt_log_database_routes(batch_id,attempt_id);
CREATE TABLE attempt_log_database_locations (
  attempt_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  database_id TEXT NOT NULL REFERENCES log_databases(id),
  PRIMARY KEY(attempt_id,database_id)
);
CREATE INDEX attempt_log_database_locations_batch_idx ON attempt_log_database_locations(batch_id,database_id);
CREATE TABLE run_batch_log_database_sizes (
  batch_id TEXT NOT NULL,
  database_id TEXT NOT NULL REFERENCES log_databases(id),
  stored_bytes BIGINT NOT NULL DEFAULT 0 CHECK(stored_bytes>=0),
  PRIMARY KEY(batch_id,database_id)
);

CREATE TABLE log_archive_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  month TEXT NOT NULL,
  project_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','building','verifying','ready','cleaning','completed','failed','cancelled')),
  total_batches INTEGER NOT NULL DEFAULT 0,
  processed_batches INTEGER NOT NULL DEFAULT 0,
  cleaned_batches INTEGER NOT NULL DEFAULT 0,
  attempt_count BIGINT NOT NULL DEFAULT 0,
  chunk_count BIGINT NOT NULL DEFAULT 0,
  source_bytes BIGINT NOT NULL DEFAULT 0,
  archive_bytes BIGINT NOT NULL DEFAULT 0,
  reclaimed_bytes BIGINT NOT NULL DEFAULT 0,
  object_key TEXT,
  filename TEXT,
  sha256 TEXT,
  index_sha256 TEXT,
  error_message TEXT,
  requested_by TEXT NOT NULL,
  cancel_requested_at TEXT,
  cleanup_requested_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX log_archive_jobs_work_idx ON log_archive_jobs(status,lease_expires_at,created_at);
CREATE INDEX log_archive_jobs_month_idx ON log_archive_jobs(month,id);
CREATE TABLE log_archive_batches (
  batch_id TEXT PRIMARY KEY NOT NULL,
  archive_id TEXT NOT NULL REFERENCES log_archive_jobs(id),
  state TEXT NOT NULL CHECK(state IN ('reserved','exported','verified','cleaning','cleaned')),
  source_bytes BIGINT NOT NULL DEFAULT 0,
  archived_at TEXT
);
CREATE INDEX log_archive_batches_job_idx ON log_archive_batches(archive_id,state,batch_id);
CREATE TABLE log_archive_worker_lock (
  id INTEGER PRIMARY KEY CHECK(id=1),
  owner TEXT,
  lease_expires_at TEXT
);
INSERT INTO log_archive_worker_lock(id) VALUES(1);

CREATE INDEX run_batches_log_archive_month_idx ON run_batches(status,updated_at,id);
CREATE INDEX execution_runs_archive_cursor_idx ON execution_runs(batch_id,id);
CREATE INDEX run_attempts_archive_cursor_idx ON run_attempts(execution_run_id,id);
