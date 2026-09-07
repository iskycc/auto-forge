-- Dispatch must not scan or sort a large import/export backlog to find its reserved work.
CREATE INDEX queue_jobs_execution_claim_idx
  ON queue_jobs (status, priority DESC, created_at, message_id, available_at)
  WHERE kind = 'dispatch-run';

CREATE INDEX queue_jobs_background_claim_idx
  ON queue_jobs (status, priority DESC, created_at, message_id, available_at)
  WHERE kind <> 'dispatch-run';
