CREATE TABLE runner_groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX runner_groups_normalized_name_uq
  ON runner_groups (normalized_name);

CREATE TABLE runner_group_members (
  group_id TEXT NOT NULL REFERENCES runner_groups(id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (group_id, runner_id)
);

CREATE INDEX runner_group_members_runner_idx
  ON runner_group_members (runner_id, group_id);
