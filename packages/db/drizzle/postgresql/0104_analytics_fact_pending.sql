CREATE TABLE analytics_fact_pending (
  attempt_id TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1
);
CREATE INDEX analytics_fact_pending_completed_idx ON analytics_fact_pending(completed_at, attempt_id);

CREATE TABLE analytics_fact_backfill (
  schema_version INTEGER PRIMARY KEY,
  after_attempt_id TEXT,
  through_attempt_id TEXT,
  finished BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE FUNCTION queue_analytics_fact_completion() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.finished_at IS NOT NULL AND OLD.outcome IS NOT NULL THEN
      RETURN NULL;
    END IF;
  END IF;
  INSERT INTO analytics_fact_pending (attempt_id, completed_at) VALUES (NEW.id, NEW.finished_at)
  ON CONFLICT (attempt_id) DO UPDATE SET
    completed_at = EXCLUDED.completed_at, revision = analytics_fact_pending.revision + 1;
  RETURN NULL;
END;
$$;

CREATE TRIGGER analytics_fact_completion
AFTER INSERT OR UPDATE OF finished_at, outcome ON run_attempts
FOR EACH ROW WHEN (NEW.finished_at IS NOT NULL AND NEW.outcome IS NOT NULL)
EXECUTE FUNCTION queue_analytics_fact_completion();

-- A fact can be regenerated while its source remains. Execution retention cascades
-- from run_attempts and must not recreate work for a deleted source row.
CREATE FUNCTION queue_removed_analytics_facts() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO analytics_fact_pending (attempt_id, completed_at)
  SELECT a.id, a.finished_at FROM removed_facts removed JOIN run_attempts a ON a.id = removed.attempt_id
  WHERE a.finished_at IS NOT NULL AND a.outcome IS NOT NULL
  ORDER BY a.id
  ON CONFLICT (attempt_id) DO UPDATE SET
    completed_at = EXCLUDED.completed_at, revision = analytics_fact_pending.revision + 1;
  RETURN NULL;
END;
$$;

CREATE TRIGGER analytics_fact_removed
AFTER DELETE ON analytics_facts REFERENCING OLD TABLE AS removed_facts
FOR EACH STATEMENT EXECUTE FUNCTION queue_removed_analytics_facts();
