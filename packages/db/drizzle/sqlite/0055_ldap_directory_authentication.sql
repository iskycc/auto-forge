ALTER TABLE ldap_configurations
  ADD COLUMN group_attribute TEXT NOT NULL DEFAULT 'memberOf';

ALTER TABLE ldap_configurations
  ADD COLUMN group_name_attribute TEXT NOT NULL DEFAULT 'cn';

ALTER TABLE ldap_configurations
  ADD COLUMN default_role TEXT NOT NULL DEFAULT 'editor'
  CHECK (default_role IN ('admin', 'editor', 'viewer'));

ALTER TABLE ldap_configurations
  ADD COLUMN transport_mode TEXT NOT NULL DEFAULT 'ldaps'
  CHECK (transport_mode IN ('ldaps', 'starttls', 'plain'));

UPDATE ldap_configurations SET transport_mode = tls_mode;

-- Historical Group searches returned each entry DN. Keep existing mappings effective; newly
-- created configurations explicitly persist the ddt-insight default of cn.
UPDATE ldap_configurations
SET group_name_attribute = 'dn'
WHERE group_base_dn IS NOT NULL AND TRIM(group_base_dn) <> '';
