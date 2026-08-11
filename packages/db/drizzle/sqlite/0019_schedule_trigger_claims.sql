CREATE TABLE schedule_trigger_claims (
  schedule_id TEXT NOT NULL REFERENCES case_suite_schedules(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  claim_id TEXT NOT NULL UNIQUE,
  lease_expires_at TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY(schedule_id, scheduled_for)
);

CREATE INDEX schedule_trigger_claims_expiry_idx
  ON schedule_trigger_claims(lease_expires_at);

CREATE UNIQUE INDEX notifications_resource_deduplication_uq
  ON notifications(user_id, kind, resource_type, resource_id)
  WHERE resource_id IS NOT NULL;
