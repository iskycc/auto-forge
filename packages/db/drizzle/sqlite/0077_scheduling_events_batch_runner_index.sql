-- A Runner log page must seek within its batch, including backward cursor reads.
CREATE INDEX scheduling_events_batch_runner_idx
  ON scheduling_events (batch_id, runner_id, recorded_at, id);
