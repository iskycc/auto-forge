ALTER TABLE ldap_configurations
ADD COLUMN updated_by TEXT NOT NULL DEFAULT '';

ALTER TABLE users
ADD COLUMN ldap_groups_json TEXT NOT NULL DEFAULT '[]';

DELETE FROM user_system_roles WHERE source = 'ldap';
DELETE FROM project_role_bindings WHERE source = 'ldap';

INSERT OR IGNORE INTO user_system_roles (user_id, role_id, source, assigned_at, assigned_by)
SELECT u.id, '00000000-0000-7000-8100-000000000001', 'ldap', c.updated_at, NULL
FROM users u
JOIN ldap_configurations c ON c.id = 'default'
WHERE u.source = 'ldap' AND c.default_role = 'admin';

INSERT OR IGNORE INTO project_role_bindings
  (user_id, project_id, role_id, source, assigned_at, assigned_by)
SELECT
  u.id,
  '00000000-0000-7000-8000-000000000001',
  CASE c.default_role
    WHEN 'editor' THEN '00000000-0000-7000-8100-000000000003'
    ELSE '00000000-0000-7000-8100-000000000005'
  END,
  'ldap',
  c.updated_at,
  NULL
FROM users u
JOIN ldap_configurations c ON c.id = 'default'
WHERE u.source = 'ldap' AND c.default_role IN ('editor', 'viewer');
