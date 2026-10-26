-- Optional telemetry: older Agents retain full conservative reservations.
ALTER TABLE runners ADD COLUMN memory_execution_credit_bytes INTEGER;
