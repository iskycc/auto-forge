CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX projects_slug_uq ON projects (slug);
CREATE UNIQUE INDEX projects_one_default_uq ON projects (is_default) WHERE is_default = TRUE;

INSERT INTO projects (id, name, slug, is_default, archived, created_at, updated_at)
VALUES (
  '00000000-0000-7000-8000-000000000001',
  '默认项目',
  'default',
  TRUE,
  FALSE,
  '2026-08-09T00:00:00.000Z',
  '2026-08-09T00:00:00.000Z'
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  normalized_username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  source TEXT NOT NULL CHECK (source IN ('local', 'ldap')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  password_hash TEXT,
  password_updated_at TEXT,
  force_password_change BOOLEAN NOT NULL DEFAULT FALSE,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE UNIQUE INDEX users_normalized_username_uq ON users (normalized_username);
CREATE INDEX users_status_updated_at_idx ON users (status, updated_at);

CREATE TABLE external_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  directory_username TEXT NOT NULL,
  attributes_json TEXT NOT NULL,
  synchronized_at TEXT NOT NULL
);

CREATE UNIQUE INDEX external_identities_provider_subject_uq
  ON external_identities (provider_id, subject);
CREATE INDEX external_identities_user_idx ON external_identities (user_id);

CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE UNIQUE INDEX user_sessions_token_hash_uq ON user_sessions (token_hash);
CREATE INDEX user_sessions_user_active_idx ON user_sessions (user_id, revoked_at, expires_at);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  role_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('system', 'project')),
  built_in BOOLEAN NOT NULL DEFAULT FALSE,
  permissions_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX roles_key_uq ON roles (role_key);

CREATE TABLE user_system_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ldap')),
  assigned_at TEXT NOT NULL,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE project_role_bindings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ldap')),
  assigned_at TEXT NOT NULL,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, project_id, role_id)
);

CREATE INDEX project_role_bindings_project_idx ON project_role_bindings (project_id, user_id);

CREATE TABLE auth_bootstrap_uses (
  token_hash TEXT PRIMARY KEY,
  used_at TEXT NOT NULL
);

CREATE TABLE ldap_configurations (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  urls_json TEXT NOT NULL,
  tls_mode TEXT NOT NULL CHECK (tls_mode IN ('ldaps', 'starttls')),
  ca_pem TEXT,
  connect_timeout_ms INTEGER NOT NULL,
  operation_timeout_ms INTEGER NOT NULL,
  page_size INTEGER NOT NULL CHECK (page_size BETWEEN 50 AND 1000),
  maximum_users INTEGER NOT NULL CHECK (maximum_users BETWEEN 1 AND 50000),
  bind_dn TEXT NOT NULL,
  bind_password_encrypted TEXT,
  user_base_dn TEXT NOT NULL,
  user_filter TEXT NOT NULL,
  user_id_attribute TEXT NOT NULL,
  username_attribute TEXT NOT NULL,
  display_name_attribute TEXT NOT NULL,
  email_attribute TEXT NOT NULL,
  group_base_dn TEXT,
  group_filter TEXT,
  group_member_attribute TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE ldap_group_mappings (
  id TEXT PRIMARY KEY,
  group_dn TEXT NOT NULL,
  normalized_group_dn TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX ldap_group_mappings_system_uq
  ON ldap_group_mappings (normalized_group_dn, role_id)
  WHERE project_id IS NULL;
CREATE UNIQUE INDEX ldap_group_mappings_project_uq
  ON ldap_group_mappings (normalized_group_dn, role_id, project_id)
  WHERE project_id IS NOT NULL;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'runner', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  result TEXT NOT NULL CHECK (result IN ('succeeded', 'rejected', 'failed')),
  request_id TEXT,
  details_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX audit_events_recorded_at_idx ON audit_events (recorded_at DESC, id DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, recorded_at DESC);
CREATE INDEX audit_events_resource_idx ON audit_events (resource_type, resource_id, recorded_at DESC);
