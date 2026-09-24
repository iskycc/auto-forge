-- Same bounded, minute-level heartbeat sampling contract as Lite.
CREATE TABLE runner_resource_samples (
  runner_id TEXT NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK (slot >= 0 AND slot < 360),
  sample_minute BIGINT NOT NULL,
  observed_at TEXT NOT NULL,
  cpu_utilization_percent DOUBLE PRECISION NOT NULL,
  memory_utilization_percent DOUBLE PRECISION NOT NULL,
  load_average_1m DOUBLE PRECISION NOT NULL,
  logical_cpu_count INTEGER NOT NULL,
  busy_slots INTEGER NOT NULL,
  max_concurrency INTEGER NOT NULL,
  PRIMARY KEY (runner_id, slot)
);

CREATE FUNCTION sample_runner_resources() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  minute_number BIGINT := FLOOR(EXTRACT(EPOCH FROM NEW.metrics_observed_at::timestamptz) / 60);
BEGIN
  INSERT INTO runner_resource_samples (
    runner_id, slot, sample_minute, observed_at, cpu_utilization_percent,
    memory_utilization_percent, load_average_1m, logical_cpu_count, busy_slots, max_concurrency
  ) VALUES (
    NEW.id, minute_number % 360, minute_number,
    NEW.metrics_observed_at, NEW.cpu_utilization_percent, NEW.memory_utilization_percent,
    NEW.load_average_1m, NEW.logical_cpu_count, NEW.busy_slots, NEW.max_concurrency
  ) ON CONFLICT (runner_id, slot) DO UPDATE SET
    sample_minute = excluded.sample_minute, observed_at = excluded.observed_at,
    cpu_utilization_percent = excluded.cpu_utilization_percent,
    memory_utilization_percent = excluded.memory_utilization_percent,
    load_average_1m = excluded.load_average_1m, logical_cpu_count = excluded.logical_cpu_count,
    busy_slots = excluded.busy_slots, max_concurrency = excluded.max_concurrency
  WHERE excluded.sample_minute > runner_resource_samples.sample_minute;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sample_runner_resources AFTER UPDATE OF metrics_observed_at ON runners
FOR EACH ROW WHEN (NEW.metrics_observed_at IS NOT NULL AND NEW.purged_at IS NULL)
EXECUTE FUNCTION sample_runner_resources();

CREATE FUNCTION purge_runner_resource_samples() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM runner_resource_samples WHERE runner_id = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purge_runner_resource_samples AFTER UPDATE OF purged_at ON runners
FOR EACH ROW WHEN (NEW.purged_at IS NOT NULL)
EXECUTE FUNCTION purge_runner_resource_samples();
