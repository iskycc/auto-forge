ALTER TABLE ldap_configurations
  ADD COLUMN verify_tls_certificate INTEGER NOT NULL DEFAULT 1
  CHECK (verify_tls_certificate IN (0, 1));
