CREATE TABLE runner_installation_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  runner_id TEXT REFERENCES runners(id) ON DELETE SET NULL,
  runner_name TEXT NOT NULL,
  connection_encrypted TEXT NOT NULL,
  expected_host_key_sha256 TEXT NOT NULL,
  installation_mode TEXT NOT NULL,
  run_as_root BOOLEAN NOT NULL DEFAULT FALSE,
  data_directory TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX runner_installation_profiles_runner_uq
  ON runner_installation_profiles(runner_id);
CREATE INDEX runner_installation_profiles_name_idx
  ON runner_installation_profiles(runner_name, updated_at);
