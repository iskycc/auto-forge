CREATE TABLE runner_rejected_contacts (
  runner_id TEXT PRIMARY KEY NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  first_rejected_at TEXT NOT NULL,
  last_rejected_at TEXT NOT NULL
);
