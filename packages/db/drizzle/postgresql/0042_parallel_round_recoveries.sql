ALTER TABLE run_batch_round_recoveries
  DROP CONSTRAINT run_batch_round_recoveries_batch_id_after_round_key;

CREATE INDEX run_batch_round_recoveries_barrier_idx
  ON run_batch_round_recoveries(batch_id, after_round, status);
