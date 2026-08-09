PRAGMA foreign_keys = OFF;

ALTER TABLE runners RENAME TO runners_shellhub_legacy;

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
  terminal_enabled INTEGER NOT NULL DEFAULT 0 CHECK (terminal_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO runners (
  id,
  credential_hash,
  name,
  disabled,
  os,
  architecture,
  agent_version,
  protocol_version,
  labels_json,
  max_concurrency,
  busy_slots,
  last_seen_at,
  terminal_enabled,
  created_at,
  updated_at
)
SELECT
  id,
  credential_hash,
  name,
  disabled,
  os,
  architecture,
  agent_version,
  protocol_version,
  labels_json,
  max_concurrency,
  busy_slots,
  last_seen_at,
  0,
  created_at,
  updated_at
FROM runners_shellhub_legacy;

DROP TABLE runners_shellhub_legacy;

CREATE UNIQUE INDEX runners_credential_hash_uq ON runners (credential_hash);
CREATE INDEX runners_last_seen_at_idx ON runners (last_seen_at);

PRAGMA foreign_keys = ON;
