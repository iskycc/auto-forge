ALTER TABLE ldap_configurations
  ADD COLUMN synchronization_interval_minutes INTEGER NOT NULL DEFAULT 0;
