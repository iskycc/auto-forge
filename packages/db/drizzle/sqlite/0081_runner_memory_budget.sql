-- Nullable for older Agents. Rolling upgrades keep percentage-based scheduling until the next capable heartbeat.
ALTER TABLE runners ADD COLUMN memory_total_bytes INTEGER;
ALTER TABLE runners ADD COLUMN memory_available_bytes INTEGER;
