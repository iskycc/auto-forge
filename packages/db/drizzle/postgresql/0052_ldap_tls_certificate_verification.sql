ALTER TABLE ldap_configurations
  ADD COLUMN verify_tls_certificate BOOLEAN NOT NULL DEFAULT TRUE;
