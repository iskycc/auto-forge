ALTER TABLE runners
  DROP COLUMN shellhub_device_id,
  ADD COLUMN terminal_enabled BOOLEAN NOT NULL DEFAULT FALSE;
