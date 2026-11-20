CREATE TABLE case_suite_member_changes_next (
  id TEXT PRIMARY KEY NOT NULL,
  suite_id TEXT NOT NULL REFERENCES case_suites(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('standard', 'ddt')),
  operation TEXT NOT NULL CHECK (operation IN ('add', 'remove', 'markers')),
  member_count INTEGER NOT NULL CHECK (member_count > 0),
  actor_id TEXT,
  actor_name TEXT,
  remark TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

INSERT INTO case_suite_member_changes_next
  (id, suite_id, kind, operation, member_count, actor_id, actor_name, remark, changed_at)
SELECT id, suite_id, kind, operation, member_count, actor_id, actor_name, remark, changed_at
FROM case_suite_member_changes;

CREATE TABLE case_suite_member_change_items_next (
  change_id TEXT NOT NULL REFERENCES case_suite_member_changes_next(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  case_label TEXT NOT NULL,
  PRIMARY KEY (change_id, case_id)
);

INSERT INTO case_suite_member_change_items_next (change_id, case_id, case_label)
SELECT change_id, case_id, case_label FROM case_suite_member_change_items;

DROP TABLE case_suite_member_change_items;
DROP TABLE case_suite_member_changes;

ALTER TABLE case_suite_member_changes_next RENAME TO case_suite_member_changes;
ALTER TABLE case_suite_member_change_items_next RENAME TO case_suite_member_change_items;

CREATE INDEX case_suite_member_changes_suite_idx ON case_suite_member_changes (suite_id, id DESC);
