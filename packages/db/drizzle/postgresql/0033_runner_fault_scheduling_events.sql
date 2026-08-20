ALTER TABLE scheduling_events
  DROP CONSTRAINT scheduling_events_event_type_check;

ALTER TABLE scheduling_events
  ADD CONSTRAINT scheduling_events_event_type_check CHECK (event_type IN
    ('batch_scheduled', 'run_assigned', 'attempt_claimed',
     'attempt_completed', 'run_held_for_round', 'runner_metrics',
     'runner_fault_rescheduled'));
