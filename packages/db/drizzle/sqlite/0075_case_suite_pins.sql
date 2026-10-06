CREATE TABLE case_suite_pins (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  suite_id TEXT NOT NULL REFERENCES case_suites(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, suite_id)
);
CREATE INDEX case_suite_pins_suite_idx ON case_suite_pins(suite_id);
