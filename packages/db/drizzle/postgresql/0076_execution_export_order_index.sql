-- Result exports seek through batch members without repeatedly sorting the entire batch.
CREATE INDEX execution_runs_batch_export_order_idx
  ON execution_runs (batch_id, class_name, display_name, id);
