import type {
  AuditListPage,
  CreateLdapUserRecord,
  CreateLocalUserRecord,
  IdentityAccessRepository,
  IdentityListPage,
  StoredLdapConfiguration,
  StoredUserCredential,
} from "@autoforge/application";
import {
  DomainError,
  isPermission,
  type AuditEvent,
  type AuthenticatedIdentity,
  type BuiltInRoleDefinition,
  type ExternalIdentity,
  type Permission,
  type Project,
  type Role,
  type RoleScope,
  type SystemRoleBindingView,
  type User,
  type UserSession,
  type UserStatus,
} from "@autoforge/domain";
import type { PoolClient, QueryResultRow } from "pg";

import type { PostgresDatabaseHandle } from "./postgres-database";

const SYSTEM_ADMIN_ROLE_ID = "00000000-0000-7000-8100-000000000001";

type UserDatabaseRow = QueryResultRow & {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  source: "local" | "ldap";
  status: "active" | "disabled";
  password_hash: string | null;
  force_password_change: boolean;
  failed_login_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
};

type RoleDatabaseRow = QueryResultRow & {
  id: string;
  role_key: string;
  name: string;
  description: string;
  scope: "system" | "project";
  built_in: boolean;
  active: boolean;
  permissions_json: string;
  created_at: string;
  updated_at: string;
};

type ProjectDatabaseRow = QueryResultRow & {
  id: string;
  name: string;
  slug: string;
  is_default: boolean;
  archived: boolean;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export class PostgresIdentityAccessRepository implements IdentityAccessRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async ensureBuiltInRoles(
    definitions: BuiltInRoleDefinition[],
    recordedAt: string,
  ): Promise<void> {
    await this.ready();
    await this.transaction(async (client) => {
      for (const role of definitions) {
        await client.query(
          `INSERT INTO roles (
             id, role_key, name, description, scope, built_in, active, permissions_json, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, $6, $7, $7)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             description = EXCLUDED.description,
             scope = EXCLUDED.scope,
             built_in = TRUE,
             active = TRUE,
             permissions_json = EXCLUDED.permissions_json,
             updated_at = EXCLUDED.updated_at`,
          [
            role.id,
            role.key,
            role.name,
            role.description,
            role.scope,
            JSON.stringify(role.permissions),
            recordedAt,
          ],
        );
      }
    });
  }

  async hasUsers(): Promise<boolean> {
    await this.ready();
    const result = await this.handle.pool.query<{ value: string }>(
      "SELECT COUNT(*) AS value FROM users",
    );
    return Number(result.rows[0]?.value ?? 0) > 0;
  }

  async bootstrapAdministrator(input: {
    tokenHash: string;
    user: CreateLocalUserRecord;
    systemRoleId: string;
    projectId: string;
    projectRoleId: string;
    recordedAt: string;
  }): Promise<User | null> {
    await this.ready();
    return this.transaction(async (client) => {
      await client.query("LOCK TABLE users IN EXCLUSIVE MODE");
      const existing = await client.query<{ value: string }>("SELECT COUNT(*) AS value FROM users");
      if (Number(existing.rows[0]?.value ?? 0) > 0) return null;
      const use = await client.query(
        `INSERT INTO auth_bootstrap_uses (token_hash, used_at)
         VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING token_hash`,
        [input.tokenHash, input.recordedAt],
      );
      if (use.rowCount === 0) return null;
      const user = await insertLocalUser(client, input.user);
      await client.query(
        `INSERT INTO user_system_roles
           (user_id, role_id, source, assigned_at, assigned_by)
         VALUES ($1, $2, 'manual', $3, $1)`,
        [user.id, input.systemRoleId, input.recordedAt],
      );
      await client.query(
        `INSERT INTO project_role_bindings
           (user_id, project_id, role_id, source, assigned_at, assigned_by)
         VALUES ($1, $2, $3, 'manual', $4, $1)`,
        [user.id, input.projectId, input.projectRoleId, input.recordedAt],
      );
      return mapUserRow(user);
    });
  }

  async findUserByUsername(normalizedUsername: string): Promise<StoredUserCredential | null> {
    await this.ready();
    const result = await this.handle.pool.query<UserDatabaseRow>(
      "SELECT * FROM users WHERE normalized_username = $1 LIMIT 1",
      [normalizedUsername],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      user: mapUserRow(row),
      ...(row.password_hash ? { passwordHash: row.password_hash } : {}),
    };
  }

  async findUser(userId: string): Promise<User | null> {
    await this.ready();
    const result = await this.handle.pool.query<UserDatabaseRow>(
      "SELECT * FROM users WHERE id = $1 LIMIT 1",
      [userId],
    );
    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async findExternalIdentity(
    providerId: string,
    subject: string,
  ): Promise<ExternalIdentity | null> {
    await this.ready();
    const result = await this.handle.pool.query<{
      id: string;
      user_id: string;
      provider_id: string;
      subject: string;
      directory_username: string;
      attributes_json: string;
      synchronized_at: string;
    }>(
      `SELECT * FROM external_identities
       WHERE provider_id = $1 AND subject = $2 LIMIT 1`,
      [providerId, subject],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          userId: row.user_id,
          providerId: row.provider_id,
          subject: row.subject,
          directoryUsername: row.directory_username,
          attributes: stringRecord(row.attributes_json),
          synchronizedAt: row.synchronized_at,
        }
      : null;
  }

  async upsertLdapUser(input: CreateLdapUserRecord): Promise<User> {
    await this.ready();
    return this.transaction(async (client) => {
      const external = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM external_identities
         WHERE provider_id = $1 AND subject = $2 FOR UPDATE`,
        [input.providerId, input.identity.subject],
      );
      const normalizedUsername = normalizeUsername(input.identity.username);
      if (external.rows[0]) {
        const result = await client.query<UserDatabaseRow>(
          `UPDATE users SET
             username = $1, normalized_username = $2, display_name = $3, email = $4, status = 'active',
             updated_at = $5, version = version + 1
           WHERE id = $6 AND source = 'ldap' RETURNING *`,
          [
            input.identity.username,
            normalizedUsername,
            input.identity.displayName,
            input.identity.email ?? null,
            input.synchronizedAt,
            external.rows[0].user_id,
          ],
        );
        const user = result.rows[0];
        if (!user) throw new DomainError("IDENTITY_CONFLICT", "LDAP 身份关联的用户无效。");
        await client.query(
          `UPDATE external_identities SET
             directory_username = $1, attributes_json = $2, synchronized_at = $3
           WHERE id = $4`,
          [
            input.identity.username,
            JSON.stringify(input.identity.attributes),
            input.synchronizedAt,
            external.rows[0].id,
          ],
        );
        return mapUserRow(user);
      }
      const collision = await client.query<{ id: string; source: "local" | "ldap" }>(
        "SELECT id, source FROM users WHERE normalized_username = $1 LIMIT 1 FOR UPDATE",
        [normalizedUsername],
      );
      if (collision.rows[0]) {
        if (collision.rows[0].source !== "ldap") {
          throw new DomainError(
            "IDENTITY_CONFLICT",
            "LDAP 用户名与已有账号冲突，需要管理员显式处理。",
          );
        }
        const updated = await client.query<UserDatabaseRow>(
          `UPDATE users SET username = $1, normalized_username = $2, display_name = $3,
             email = $4, status = 'active', updated_at = $5, version = version + 1
           WHERE id = $6 RETURNING *`,
          [
            input.identity.username,
            normalizedUsername,
            input.identity.displayName,
            input.identity.email ?? null,
            input.synchronizedAt,
            collision.rows[0].id,
          ],
        );
        const linkedIdentity = await client.query<{ id: string }>(
          `SELECT id FROM external_identities
           WHERE provider_id = $1 AND user_id = $2 LIMIT 1 FOR UPDATE`,
          [input.providerId, collision.rows[0].id],
        );
        if (linkedIdentity.rows[0]) {
          await client.query(
            `UPDATE external_identities SET subject = $1, directory_username = $2,
               attributes_json = $3, synchronized_at = $4 WHERE id = $5`,
            [
              input.identity.subject,
              input.identity.username,
              JSON.stringify(input.identity.attributes),
              input.synchronizedAt,
              linkedIdentity.rows[0].id,
            ],
          );
        } else {
          await client.query(
            `INSERT INTO external_identities
             (id, user_id, provider_id, subject, directory_username, attributes_json, synchronized_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              input.externalIdentityId,
              collision.rows[0].id,
              input.providerId,
              input.identity.subject,
              input.identity.username,
              JSON.stringify(input.identity.attributes),
              input.synchronizedAt,
            ],
          );
        }
        return mapUserRow(
          requiredRow(updated.rows[0], "PostgreSQL did not return migrated LDAP user."),
        );
      }
      const created = await client.query<UserDatabaseRow>(
        `INSERT INTO users (
           id, username, normalized_username, display_name, email, source, status,
           password_hash, password_updated_at, force_password_change, failed_login_attempts,
           locked_until, last_login_at, created_at, updated_at, version
         ) VALUES ($1, $2, $3, $4, $5, 'ldap', 'active', NULL, NULL, FALSE, 0, NULL, NULL, $6, $6, 1)
         RETURNING *`,
        [
          input.userId,
          input.identity.username,
          normalizedUsername,
          input.identity.displayName,
          input.identity.email ?? null,
          input.synchronizedAt,
        ],
      );
      await client.query(
        `INSERT INTO external_identities (
           id, user_id, provider_id, subject, directory_username, attributes_json, synchronized_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.externalIdentityId,
          input.userId,
          input.providerId,
          input.identity.subject,
          input.identity.username,
          JSON.stringify(input.identity.attributes),
          input.synchronizedAt,
        ],
      );
      return mapUserRow(requiredRow(created.rows[0], "PostgreSQL did not return LDAP user."));
    });
  }

  async recordLoginFailure(
    userId: string,
    failedAttempts: number,
    lockedUntil: string | undefined,
    recordedAt: string,
  ): Promise<void> {
    await this.ready();
    await this.handle.pool.query(
      `UPDATE users SET failed_login_attempts = $1, locked_until = $2,
       updated_at = $3, version = version + 1 WHERE id = $4`,
      [failedAttempts, lockedUntil ?? null, recordedAt, userId],
    );
  }

  async createSessionAfterLogin(input: {
    id: string;
    userId: string;
    tokenHash: string;
    createdAt: string;
    expiresAt: string;
  }): Promise<User> {
    await this.ready();
    return this.transaction(async (client) => {
      const result = await client.query<UserDatabaseRow>(
        `UPDATE users SET failed_login_attempts = 0, locked_until = NULL,
         last_login_at = $1, updated_at = $1, version = version + 1
         WHERE id = $2 AND status = 'active' RETURNING *`,
        [input.createdAt, input.userId],
      );
      const user = result.rows[0];
      if (!user) throw new DomainError("AUTHENTICATION_FAILED", "用户名或密码无效。");
      await client.query(
        `INSERT INTO user_sessions
           (id, user_id, token_hash, expires_at, last_seen_at, created_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $5, NULL)`,
        [input.id, input.userId, input.tokenHash, input.expiresAt, input.createdAt],
      );
      return mapUserRow(user);
    });
  }

  async resolveSession(tokenHash: string, now: string): Promise<AuthenticatedIdentity | null> {
    await this.ready();
    // 会话续期、用户读取与角色聚合合并为单条语句：鉴权是每次页面/探针读取
    // 的固定成本，四段串行往返在高并发下会被事件循环排队显著放大。
    const result = await this.handle.pool.query<
      { session_id: string } & UserDatabaseRow & {
          system_permissions: string[] | null;
          project_bindings: Array<{ p: string; r: string }> | null;
        }
    >(
      `WITH touched AS (
         UPDATE user_sessions SET last_seen_at = $2
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2
         RETURNING id, user_id
       )
       SELECT s.id AS session_id, u.*,
         (SELECT json_agg(r.permissions_json) FROM user_system_roles b
           JOIN roles r ON r.id = b.role_id AND r.active = TRUE
           WHERE b.user_id = u.id) AS system_permissions,
         (SELECT json_agg(json_build_object('p', b.project_id, 'r', r.permissions_json))
           FROM project_role_bindings b
           JOIN roles r ON r.id = b.role_id AND r.active = TRUE
           WHERE b.user_id = u.id) AS project_bindings
       FROM touched s
       JOIN users u ON u.id = s.user_id
       WHERE u.status = 'active'`,
      [tokenHash, now],
    );
    const row = result.rows[0];
    if (!row) return null;
    const projectPermissions: Record<string, Permission[]> = {};
    for (const binding of row.project_bindings ?? []) {
      projectPermissions[binding.p] = mergePermissions(
        projectPermissions[binding.p] ?? [],
        permissions(binding.r),
      );
    }
    return {
      user: mapUserRow(row),
      sessionId: row.session_id,
      systemPermissions: mergePermissions(
        [],
        (row.system_permissions ?? []).flatMap((entry) => permissions(entry)),
      ),
      projectPermissions,
    };
  }

  async touchSession(sessionId: string, touchedAt: string): Promise<void> {
    await this.ready();
    await this.handle.pool.query("UPDATE user_sessions SET last_seen_at = $1 WHERE id = $2", [
      touchedAt,
      sessionId,
    ]);
  }

  async revokeSession(sessionId: string, revokedAt: string): Promise<void> {
    await this.ready();
    await this.handle.pool.query(
      "UPDATE user_sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL",
      [revokedAt, sessionId],
    );
  }

  async revokeUserSessions(userId: string, revokedAt: string): Promise<void> {
    await this.ready();
    await this.handle.pool.query(
      "UPDATE user_sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL",
      [revokedAt, userId],
    );
  }

  async revokeUserSessionsForRole(roleId: string, revokedAt: string): Promise<void> {
    await this.ready();
    await this.handle.pool.query(
      `UPDATE user_sessions SET revoked_at = $1
       WHERE revoked_at IS NULL AND user_id IN (
         SELECT user_id FROM user_system_roles WHERE role_id = $2
         UNION
         SELECT user_id FROM project_role_bindings WHERE role_id = $2
       )`,
      [revokedAt, roleId],
    );
  }

  async listUserSessions(userId: string, now: string): Promise<UserSession[]> {
    await this.ready();
    const result = await this.handle.pool.query<{
      id: string;
      user_id: string;
      expires_at: string;
      last_seen_at: string;
      created_at: string;
      revoked_at: string | null;
    }>(
      `SELECT id, user_id, expires_at, last_seen_at, created_at, revoked_at
       FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2
       ORDER BY last_seen_at DESC`,
      [userId, now],
    );
    return result.rows.map(mapUserSessionRow);
  }

  async findSession(sessionId: string): Promise<UserSession | null> {
    await this.ready();
    const result = await this.handle.pool.query<{
      id: string;
      user_id: string;
      expires_at: string;
      last_seen_at: string;
      created_at: string;
      revoked_at: string | null;
    }>(
      `SELECT id, user_id, expires_at, last_seen_at, created_at, revoked_at
       FROM user_sessions WHERE id = $1 LIMIT 1`,
      [sessionId],
    );
    return result.rows[0] ? mapUserSessionRow(result.rows[0]) : null;
  }

  async listUsers(input: {
    query?: string;
    source?: "local" | "ldap";
    cursor?: string;
    limit: number;
  }): Promise<IdentityListPage> {
    await this.ready();
    const parameters: unknown[] = [];
    const conditions: string[] = [];
    if (input.query) {
      parameters.push(`%${input.query.trim()}%`);
      conditions.push(
        `(username ILIKE $${parameters.length} OR display_name ILIKE $${parameters.length})`,
      );
    }
    if (input.source) {
      parameters.push(input.source);
      conditions.push(`source = $${parameters.length}`);
    }
    if (input.cursor) {
      parameters.push(input.cursor);
      conditions.push(`id < $${parameters.length}`);
    }
    parameters.push(input.limit + 1);
    const result = await this.handle.pool.query<UserDatabaseRow>(
      `SELECT * FROM users ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY id DESC LIMIT $${parameters.length}`,
      parameters,
    );
    const page = result.rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map(mapUserRow),
      ...(result.rows.length > input.limit && last ? { nextCursor: last.id } : {}),
    };
  }

  async createLocalUser(record: CreateLocalUserRecord): Promise<User> {
    await this.ready();
    const collision = await this.handle.pool.query(
      "SELECT id FROM users WHERE normalized_username = $1 LIMIT 1",
      [record.normalizedUsername],
    );
    if (collision.rowCount) throw new DomainError("USER_CONFLICT", "用户名已存在。");
    return mapUserRow(await this.transaction((client) => insertLocalUser(client, record)));
  }

  async updateUserStatus(userId: string, status: UserStatus, updatedAt: string): Promise<User> {
    await this.ready();
    return this.transaction(async (client) => {
      if (status === "disabled") await ensureNotLastAdministrator(client, userId);
      const result = await client.query<UserDatabaseRow>(
        `UPDATE users SET status = $1,
         failed_login_attempts = CASE WHEN $1 = 'active' THEN 0 ELSE failed_login_attempts END,
         locked_until = CASE WHEN $1 = 'active' THEN NULL ELSE locked_until END,
         updated_at = $2, version = version + 1
         WHERE id = $3 RETURNING *`,
        [status, updatedAt, userId],
      );
      if (!result.rows[0]) throw new DomainError("USER_NOT_FOUND", "指定用户不存在。");
      return mapUserRow(result.rows[0]);
    });
  }

  async resetPassword(
    userId: string,
    passwordHash: string,
    forcePasswordChange: boolean,
    updatedAt: string,
  ): Promise<User> {
    await this.ready();
    const result = await this.handle.pool.query<UserDatabaseRow>(
      `UPDATE users SET password_hash = $1, password_updated_at = $2,
       force_password_change = $3, failed_login_attempts = 0, locked_until = NULL,
       updated_at = $2, version = version + 1
       WHERE id = $4 AND source = 'local' RETURNING *`,
      [passwordHash, updatedAt, forcePasswordChange, userId],
    );
    if (!result.rows[0]) throw new DomainError("USER_NOT_FOUND", "指定本地用户不存在。");
    return mapUserRow(result.rows[0]);
  }

  async listRoles(): Promise<Role[]> {
    await this.ready();
    const result = await this.handle.pool.query<RoleDatabaseRow>(
      "SELECT * FROM roles ORDER BY scope, role_key",
    );
    return result.rows.map(mapRoleRow);
  }

  async findRole(roleId: string): Promise<Role | null> {
    await this.ready();
    const result = await this.handle.pool.query<RoleDatabaseRow>(
      "SELECT * FROM roles WHERE id = $1 LIMIT 1",
      [roleId],
    );
    return result.rows[0] ? mapRoleRow(result.rows[0]) : null;
  }

  async createRole(input: {
    id: string;
    key: string;
    name: string;
    description: string;
    scope: RoleScope;
    permissions: Permission[];
    createdAt: string;
  }): Promise<Role> {
    await this.ready();
    const result = await this.handle.pool.query<RoleDatabaseRow>(
      `INSERT INTO roles
       (id, role_key, name, description, scope, built_in, permissions_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, FALSE, $6, $7, $7) RETURNING *`,
      [
        input.id,
        input.key,
        input.name,
        input.description,
        input.scope,
        JSON.stringify(input.permissions),
        input.createdAt,
      ],
    );
    return mapRoleRow(requiredRow(result.rows[0], "PostgreSQL did not return role."));
  }

  async updateRole(input: {
    id: string;
    name?: string;
    description?: string;
    scope?: RoleScope;
    permissions?: Permission[];
    active?: boolean;
    updatedAt: string;
  }): Promise<Role> {
    await this.ready();
    const current = await this.findRole(input.id);
    if (!current || current.builtIn)
      throw new DomainError("ROLE_NOT_FOUND", "指定自定义角色不存在。");
    const result = await this.handle.pool.query<RoleDatabaseRow>(
      `UPDATE roles SET name = $1, description = $2, scope = $3,
       permissions_json = $4, active = $5, updated_at = $6
       WHERE id = $7 AND built_in = FALSE RETURNING *`,
      [
        input.name ?? current.name,
        input.description ?? current.description,
        input.scope ?? current.scope,
        JSON.stringify(input.permissions ?? current.permissions),
        input.active ?? current.active,
        input.updatedAt,
        input.id,
      ],
    );
    return mapRoleRow(requiredRow(result.rows[0], "PostgreSQL did not return role."));
  }

  async deleteRole(roleId: string): Promise<boolean> {
    await this.ready();
    const result = await this.handle.pool.query(
      `DELETE FROM roles r WHERE r.id = $1 AND r.built_in = FALSE
       AND NOT EXISTS (SELECT 1 FROM user_system_roles b WHERE b.role_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM project_role_bindings b WHERE b.role_id = r.id)
       RETURNING id`,
      [roleId],
    );
    return Boolean(result.rowCount);
  }

  async assignSystemRole(
    userId: string,
    roleId: string,
    actorId: string,
    assignedAt: string,
  ): Promise<void> {
    await this.ready();
    await this.handle.pool.query(
      `INSERT INTO user_system_roles (user_id, role_id, source, assigned_at, assigned_by)
       VALUES ($1, $2, 'manual', $3, $4)
       ON CONFLICT (user_id, role_id) DO UPDATE SET
         source = 'manual', assigned_at = EXCLUDED.assigned_at, assigned_by = EXCLUDED.assigned_by`,
      [userId, roleId, assignedAt, actorId],
    );
  }

  async assignProjectRole(input: {
    userId: string;
    projectId: string;
    roleId: string;
    actorId: string;
    assignedAt: string;
  }): Promise<void> {
    await this.ready();
    await this.handle.pool.query(
      `INSERT INTO project_role_bindings
       (user_id, project_id, role_id, source, assigned_at, assigned_by)
       VALUES ($1, $2, $3, 'manual', $4, $5)
       ON CONFLICT (user_id, project_id, role_id) DO UPDATE SET
         source = 'manual', assigned_at = EXCLUDED.assigned_at, assigned_by = EXCLUDED.assigned_by`,
      [input.userId, input.projectId, input.roleId, input.assignedAt, input.actorId],
    );
  }

  async removeSystemRole(userId: string, roleId: string): Promise<boolean> {
    await this.ready();
    return this.transaction(async (client) => {
      if (roleId === SYSTEM_ADMIN_ROLE_ID) await ensureNotLastAdministrator(client, userId);
      const result = await client.query(
        "DELETE FROM user_system_roles WHERE user_id = $1 AND role_id = $2",
        [userId, roleId],
      );
      return result.rowCount === 1;
    });
  }

  async removeProjectRole(userId: string, projectId: string, roleId: string): Promise<boolean> {
    await this.ready();
    const result = await this.handle.pool.query(
      "DELETE FROM project_role_bindings WHERE user_id = $1 AND project_id = $2 AND role_id = $3",
      [userId, projectId, roleId],
    );
    return result.rowCount === 1;
  }

  async listProjectMemberships(
    projectId: string,
  ): Promise<Array<{ user: User; roleIds: string[] }>> {
    await this.ready();
    const result = await this.handle.pool.query<UserDatabaseRow & { role_id: string }>(
      `SELECT u.*, b.role_id FROM project_role_bindings b
       JOIN users u ON u.id = b.user_id WHERE b.project_id = $1
       ORDER BY u.display_name, b.role_id`,
      [projectId],
    );
    const memberships = new Map<string, { user: User; roleIds: string[] }>();
    for (const row of result.rows) {
      const membership = memberships.get(row.id) ?? { user: mapUserRow(row), roleIds: [] };
      membership.roleIds.push(row.role_id);
      memberships.set(row.id, membership);
    }
    return [...memberships.values()];
  }

  async listProjects(projectIds?: readonly string[]): Promise<Project[]> {
    await this.ready();
    if (projectIds?.length === 0) return [];
    const result = await this.handle.pool.query<ProjectDatabaseRow>(
      `SELECT * FROM projects ${projectIds ? "WHERE id = ANY($1::text[])" : ""} ORDER BY name`,
      projectIds ? [[...projectIds]] : [],
    );
    return result.rows.map(mapProjectRow);
  }

  async createProject(input: {
    id: string;
    name: string;
    slug: string;
    ownerUserId?: string;
    createdAt: string;
  }): Promise<Project> {
    await this.ready();
    const result = await this.handle.pool.query<ProjectDatabaseRow>(
      `INSERT INTO projects (id, name, slug, is_default, archived, owner_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, FALSE, FALSE, $4, $5, $5) RETURNING *`,
      [input.id, input.name, input.slug, input.ownerUserId ?? null, input.createdAt],
    );
    return mapProjectRow(requiredRow(result.rows[0], "PostgreSQL did not return project."));
  }

  async archiveProject(projectId: string, archivedAt: string): Promise<Project> {
    await this.ready();
    const result = await this.handle.pool.query<ProjectDatabaseRow>(
      `UPDATE projects SET archived = TRUE, updated_at = $1 WHERE id = $2 RETURNING *`,
      [archivedAt, projectId],
    );
    if (!result.rows[0]) throw new DomainError("PROJECT_NOT_FOUND", "指定项目不存在。");
    return mapProjectRow(result.rows[0]);
  }

  async transferProjectOwner(input: {
    projectId: string;
    ownerUserId: string;
    updatedAt: string;
  }): Promise<Project> {
    await this.ready();
    const result = await this.handle.pool.query<ProjectDatabaseRow>(
      `UPDATE projects SET owner_user_id = $1, updated_at = $2 WHERE id = $3 RETURNING *`,
      [input.ownerUserId, input.updatedAt, input.projectId],
    );
    if (!result.rows[0]) throw new DomainError("PROJECT_NOT_FOUND", "指定项目不存在。");
    return mapProjectRow(result.rows[0]);
  }

  async listSystemRoleBindingsForActiveUsers(): Promise<SystemRoleBindingView[]> {
    await this.ready();
    const result = await this.handle.pool.query<{
      user_id: string;
      role_id: string;
      permissions_json: string;
    }>(
      `SELECT b.user_id, b.role_id, r.permissions_json
       FROM user_system_roles b
       JOIN roles r ON r.id = b.role_id AND r.active = TRUE
       JOIN users u ON u.id = b.user_id
       WHERE u.status = 'active'`,
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      roleId: row.role_id,
      permissions: permissions(row.permissions_json),
    }));
  }

  async listSystemRoleBindings(): Promise<Array<{ userId: string; roleId: string }>> {
    await this.ready();
    const result = await this.handle.pool.query<{ user_id: string; role_id: string }>(
      "SELECT user_id, role_id FROM user_system_roles ORDER BY user_id, role_id",
    );
    return result.rows.map((row) => ({ userId: row.user_id, roleId: row.role_id }));
  }

  async getLdapConfiguration(): Promise<StoredLdapConfiguration | null> {
    await this.ready();
    const result = await this.handle.pool.query<LdapDatabaseRow>(
      "SELECT * FROM ldap_configurations WHERE id = 'default'",
    );
    return result.rows[0] ? mapLdapRow(result.rows[0]) : null;
  }

  async saveLdapConfiguration(
    input: Omit<StoredLdapConfiguration, "createdAt" | "updatedAt" | "version"> & {
      updatedAt: string;
    },
  ): Promise<StoredLdapConfiguration> {
    await this.ready();
    const result = await this.handle.pool.query<LdapDatabaseRow>(
      `INSERT INTO ldap_configurations (
         id, enabled, urls_json, tls_mode, ca_pem, verify_tls_certificate,
         connect_timeout_ms, operation_timeout_ms,
         page_size, maximum_users, synchronization_interval_minutes, bind_dn, bind_password_encrypted, user_base_dn, user_filter, user_id_attribute,
         username_attribute, display_name_attribute, email_attribute, group_base_dn,
         group_filter, group_member_attribute, group_attribute, group_name_attribute,
         default_role, transport_mode, created_at, updated_at, version
       ) VALUES (
         'default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $26, 1
       ) ON CONFLICT (id) DO UPDATE SET
         enabled = EXCLUDED.enabled, urls_json = EXCLUDED.urls_json,
         tls_mode = EXCLUDED.tls_mode, ca_pem = EXCLUDED.ca_pem,
         verify_tls_certificate = EXCLUDED.verify_tls_certificate,
         connect_timeout_ms = EXCLUDED.connect_timeout_ms,
         operation_timeout_ms = EXCLUDED.operation_timeout_ms,
         page_size = EXCLUDED.page_size, maximum_users = EXCLUDED.maximum_users,
         synchronization_interval_minutes = EXCLUDED.synchronization_interval_minutes,
         bind_dn = EXCLUDED.bind_dn,
         bind_password_encrypted = EXCLUDED.bind_password_encrypted,
         user_base_dn = EXCLUDED.user_base_dn, user_filter = EXCLUDED.user_filter,
         user_id_attribute = EXCLUDED.user_id_attribute,
         username_attribute = EXCLUDED.username_attribute,
         display_name_attribute = EXCLUDED.display_name_attribute,
         email_attribute = EXCLUDED.email_attribute, group_base_dn = EXCLUDED.group_base_dn,
         group_filter = EXCLUDED.group_filter,
         group_member_attribute = EXCLUDED.group_member_attribute,
         group_attribute = EXCLUDED.group_attribute,
         group_name_attribute = EXCLUDED.group_name_attribute,
         default_role = EXCLUDED.default_role,
         transport_mode = EXCLUDED.transport_mode,
         updated_at = EXCLUDED.updated_at, version = ldap_configurations.version + 1
       RETURNING *`,
      [
        input.enabled,
        JSON.stringify(input.url ? [input.url] : []),
        input.transportMode === "ldaps" ? "ldaps" : "starttls",
        input.caPem ?? null,
        input.verifyTlsCertificate,
        input.connectTimeoutMs,
        input.operationTimeoutMs,
        input.pageSize,
        input.maximumUsers,
        input.synchronizationIntervalMinutes,
        input.bindDn,
        input.bindPasswordEncrypted ?? null,
        input.userBaseDn,
        input.userFilter,
        input.usernameAttribute,
        input.usernameAttribute,
        input.displayNameAttribute,
        input.emailAttribute,
        input.groupSearchBase || null,
        input.groupSearchFilter || null,
        input.groupAttribute || "memberOf",
        input.groupAttribute,
        input.groupNameAttribute,
        input.defaultRole,
        input.transportMode,
        input.updatedAt,
      ],
    );
    return mapLdapRow(requiredRow(result.rows[0], "PostgreSQL did not return LDAP config."));
  }

  async listLdapGroupMappings(): Promise<
    Array<{ id: string; groupDn: string; roleId: string; projectId?: string; priority: number }>
  > {
    await this.ready();
    const result = await this.handle.pool.query<{
      id: string;
      group_dn: string;
      role_id: string;
      project_id: string | null;
      priority: number;
    }>(
      "SELECT id, group_dn, role_id, project_id, priority FROM ldap_group_mappings ORDER BY priority DESC, created_at",
    );
    return result.rows.map((row) => ({
      id: row.id,
      groupDn: row.group_dn,
      roleId: row.role_id,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      priority: row.priority,
    }));
  }

  async addLdapGroupMapping(input: {
    id: string;
    groupDn: string;
    normalizedGroupDn: string;
    roleId: string;
    projectId?: string;
    priority: number;
    recordedAt: string;
  }): Promise<void> {
    await this.ready();
    await this.handle.pool.query(
      `INSERT INTO ldap_group_mappings
       (id, group_dn, normalized_group_dn, role_id, project_id, priority, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [
        input.id,
        input.groupDn,
        input.normalizedGroupDn,
        input.roleId,
        input.projectId ?? null,
        input.priority,
        input.recordedAt,
      ],
    );
  }

  async replaceLdapRoleBindings(input: {
    userId: string;
    groupDns: string[];
    mappings: Array<{ groupDn: string; roleId: string; projectId?: string; priority: number }>;
    recordedAt: string;
  }): Promise<void> {
    await this.ready();
    await this.transaction(async (client) => {
      await client.query("DELETE FROM user_system_roles WHERE user_id = $1 AND source = 'ldap'", [
        input.userId,
      ]);
      await client.query(
        "DELETE FROM project_role_bindings WHERE user_id = $1 AND source = 'ldap'",
        [input.userId],
      );
      const groupSet = new Set(input.groupDns);
      for (const mapping of input.mappings) {
        if (!groupSet.has(normalizeDn(mapping.groupDn))) continue;
        if (mapping.projectId) {
          await client.query(
            `INSERT INTO project_role_bindings
             (user_id, project_id, role_id, source, assigned_at, assigned_by)
             VALUES ($1, $2, $3, 'ldap', $4, NULL) ON CONFLICT DO NOTHING`,
            [input.userId, mapping.projectId, mapping.roleId, input.recordedAt],
          );
        } else {
          await client.query(
            `INSERT INTO user_system_roles
             (user_id, role_id, source, assigned_at, assigned_by)
             VALUES ($1, $2, 'ldap', $3, NULL) ON CONFLICT DO NOTHING`,
            [input.userId, mapping.roleId, input.recordedAt],
          );
        }
      }
    });
  }

  async assignLdapInitialRole(input: {
    userId: string;
    roleId: string;
    projectId?: string;
    recordedAt: string;
  }): Promise<void> {
    await this.ready();
    if (input.projectId) {
      await this.handle.pool.query(
        `INSERT INTO project_role_bindings
         (user_id, project_id, role_id, source, assigned_at, assigned_by)
         VALUES ($1, $2, $3, 'manual', $4, NULL) ON CONFLICT DO NOTHING`,
        [input.userId, input.projectId, input.roleId, input.recordedAt],
      );
      return;
    }
    await this.handle.pool.query(
      `INSERT INTO user_system_roles
       (user_id, role_id, source, assigned_at, assigned_by)
       VALUES ($1, $2, 'manual', $3, NULL) ON CONFLICT DO NOTHING`,
      [input.userId, input.roleId, input.recordedAt],
    );
  }

  async disableMissingLdapUsers(input: {
    providerId: string;
    activeSubjects: string[];
    recordedAt: string;
  }): Promise<string[]> {
    await this.ready();
    return this.transaction(async (client) => {
      const result = await client.query<{ user_id: string; subject: string }>(
        `SELECT e.user_id, e.subject FROM external_identities e
         JOIN users u ON u.id = e.user_id
         WHERE e.provider_id = $1 AND u.status = 'active' FOR UPDATE OF u`,
        [input.providerId],
      );
      const activeSubjects = new Set(input.activeSubjects);
      const userIds = result.rows
        .filter((identity) => !activeSubjects.has(identity.subject))
        .map((identity) => identity.user_id);
      if (userIds.length === 0) return [];
      await client.query(
        `UPDATE users SET status = 'disabled', updated_at = $1, version = version + 1
         WHERE id = ANY($2::text[])`,
        [input.recordedAt, userIds],
      );
      await client.query(
        `UPDATE user_sessions SET revoked_at = $1
         WHERE user_id = ANY($2::text[]) AND revoked_at IS NULL`,
        [input.recordedAt, userIds],
      );
      return userIds;
    });
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.ready();
    await this.handle.pool.query(
      `INSERT INTO audit_events (
         id, actor_type, actor_id, action, resource_type, resource_id,
         project_id, result, request_id, details_json, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        event.id,
        event.actorType,
        event.actorId ?? null,
        event.action,
        event.resourceType,
        event.resourceId ?? null,
        event.projectId ?? null,
        event.result,
        event.requestId ?? null,
        JSON.stringify(event.details),
        event.recordedAt,
      ],
    );
  }

  async listAudit(input: {
    projectIds?: readonly string[];
    includeUnscoped?: boolean;
    actorId?: string;
    action?: string;
    resourceType?: string;
    result?: AuditEvent["result"];
    recordedAfter?: string;
    recordedBefore?: string;
    cursor?: string;
    limit: number;
  }): Promise<AuditListPage> {
    await this.ready();
    if (input.projectIds?.length === 0) return { items: [] };
    const parameters: unknown[] = [];
    const conditions: string[] = [];
    if (input.projectIds) {
      parameters.push([...input.projectIds]);
      const scopedCondition = `project_id = ANY($${parameters.length}::text[])`;
      conditions.push(
        input.includeUnscoped ? `(${scopedCondition} OR project_id IS NULL)` : scopedCondition,
      );
    }
    for (const [column, value] of [
      ["actor_id", input.actorId],
      ["action", input.action],
      ["resource_type", input.resourceType],
      ["result", input.result],
    ] as const) {
      if (!value) continue;
      parameters.push(value);
      conditions.push(`${column} = $${parameters.length}`);
    }
    if (input.recordedAfter) {
      parameters.push(input.recordedAfter);
      conditions.push(`recorded_at > $${parameters.length}`);
    }
    if (input.recordedBefore) {
      parameters.push(input.recordedBefore);
      conditions.push(`recorded_at < $${parameters.length}`);
    }
    if (input.cursor) {
      parameters.push(input.cursor);
      conditions.push(`id < $${parameters.length}`);
    }
    parameters.push(input.limit + 1);
    const result = await this.handle.pool.query<AuditDatabaseRow>(
      `SELECT * FROM audit_events ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY recorded_at DESC, id DESC LIMIT $${parameters.length}`,
      parameters,
    );
    const page = result.rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map(mapAuditRow),
      ...(result.rows.length > input.limit && last ? { nextCursor: last.id } : {}),
    };
  }

  private async ready(): Promise<void> {
    await this.handle.ready;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.handle.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

type LdapDatabaseRow = QueryResultRow & {
  enabled: boolean;
  urls_json: string;
  tls_mode: "ldaps" | "starttls";
  ca_pem: string | null;
  verify_tls_certificate: boolean;
  connect_timeout_ms: number;
  operation_timeout_ms: number;
  page_size: number;
  maximum_users: number;
  synchronization_interval_minutes: number;
  bind_dn: string;
  bind_password_encrypted: string | null;
  user_base_dn: string;
  user_filter: string;
  user_id_attribute: string;
  username_attribute: string;
  display_name_attribute: string;
  email_attribute: string;
  group_base_dn: string | null;
  group_filter: string | null;
  group_member_attribute: string;
  group_attribute: string;
  group_name_attribute: string;
  default_role: "admin" | "editor" | "viewer";
  transport_mode: "ldaps" | "starttls" | "plain";
  created_at: string;
  updated_at: string;
  version: number;
};

type AuditDatabaseRow = QueryResultRow & {
  id: string;
  actor_type: "user" | "runner" | "system";
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  project_id: string | null;
  result: "succeeded" | "rejected" | "failed";
  request_id: string | null;
  details_json: string;
  recorded_at: string;
};

async function insertLocalUser(
  client: PoolClient,
  record: CreateLocalUserRecord,
): Promise<UserDatabaseRow> {
  const result = await client.query<UserDatabaseRow>(
    `INSERT INTO users (
       id, username, normalized_username, display_name, email, source, status,
       password_hash, password_updated_at, force_password_change, failed_login_attempts,
       locked_until, last_login_at, created_at, updated_at, version
     ) VALUES ($1, $2, $3, $4, $5, 'local', 'active', $6, $7, $8, 0, NULL, NULL, $7, $7, 1)
     RETURNING *`,
    [
      record.id,
      record.username,
      record.normalizedUsername,
      record.displayName,
      record.email ?? null,
      record.passwordHash,
      record.createdAt,
      record.forcePasswordChange,
    ],
  );
  return requiredRow(result.rows[0], "PostgreSQL did not return local user.");
}

async function ensureNotLastAdministrator(client: PoolClient, userId: string): Promise<void> {
  const target = await client.query(
    "SELECT 1 FROM user_system_roles WHERE user_id = $1 AND role_id = $2",
    [userId, SYSTEM_ADMIN_ROLE_ID],
  );
  if (!target.rowCount) return;
  const active = await client.query<{ value: string }>(
    `SELECT COUNT(*) AS value FROM user_system_roles b
     JOIN users u ON u.id = b.user_id
     WHERE b.role_id = $1 AND u.status = 'active'`,
    [SYSTEM_ADMIN_ROLE_ID],
  );
  if (Number(active.rows[0]?.value ?? 0) <= 1) {
    throw new DomainError("LAST_ADMIN_REQUIRED", "不能禁用最后一位系统管理员。");
  }
}

function mapUserRow(row: UserDatabaseRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    ...(row.email ? { email: row.email } : {}),
    source: row.source,
    status: row.status,
    forcePasswordChange: row.force_password_change,
    failedLoginAttempts: row.failed_login_attempts,
    ...(row.locked_until ? { lockedUntil: row.locked_until } : {}),
    ...(row.last_login_at ? { lastLoginAt: row.last_login_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function mapUserSessionRow(row: {
  id: string;
  user_id: string;
  expires_at: string;
  last_seen_at: string;
  created_at: string;
  revoked_at: string | null;
}): UserSession {
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function mapProjectRow(row: ProjectDatabaseRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isDefault: row.is_default,
    archived: row.archived,
    ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoleRow(row: RoleDatabaseRow): Role {
  return {
    id: row.id,
    key: row.role_key,
    name: row.name,
    description: row.description,
    scope: row.scope,
    builtIn: row.built_in,
    active: row.active,
    permissions: permissions(row.permissions_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLdapRow(row: LdapDatabaseRow): StoredLdapConfiguration {
  return {
    enabled: row.enabled,
    url: stringArray(row.urls_json)[0] ?? "",
    transportMode: row.transport_mode,
    verifyTlsCertificate: row.verify_tls_certificate,
    ...(row.ca_pem ? { caPem: row.ca_pem } : {}),
    connectTimeoutMs: row.connect_timeout_ms,
    operationTimeoutMs: row.operation_timeout_ms,
    pageSize: row.page_size,
    maximumUsers: row.maximum_users,
    synchronizationIntervalMinutes: row.synchronization_interval_minutes,
    bindDn: row.bind_dn,
    ...(row.bind_password_encrypted ? { bindPasswordEncrypted: row.bind_password_encrypted } : {}),
    userBaseDn: row.user_base_dn,
    userFilter: row.user_filter,
    usernameAttribute: row.username_attribute,
    displayNameAttribute: row.display_name_attribute,
    emailAttribute: row.email_attribute,
    groupAttribute: row.group_attribute,
    groupSearchBase: row.group_base_dn ?? "",
    groupSearchFilter: row.group_filter ?? "(member={{userDn}})",
    groupNameAttribute: row.group_name_attribute,
    defaultRole: row.default_role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function mapAuditRow(row: AuditDatabaseRow): AuditEvent {
  return {
    id: row.id,
    actorType: row.actor_type,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    action: row.action,
    resourceType: row.resource_type,
    ...(row.resource_id ? { resourceId: row.resource_id } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    result: row.result,
    ...(row.request_id ? { requestId: row.request_id } : {}),
    details: auditDetails(row.details_json),
    recordedAt: row.recorded_at,
  };
}

function permissions(json: string): Permission[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed)
    ? [
        ...new Set(
          parsed.filter(
            (value): value is Permission => typeof value === "string" && isPermission(value),
          ),
        ),
      ]
    : [];
}

function mergePermissions(current: Permission[], incoming: Permission[]): Permission[] {
  return [...new Set([...current, ...incoming])].sort();
}

function stringArray(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed)
    ? parsed.filter((value): value is string => typeof value === "string")
    : [];
}

function stringRecord(json: string): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function auditDetails(json: string): AuditEvent["details"] {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string | number | boolean | null] =>
        ["string", "number", "boolean"].includes(typeof entry[1]) || entry[1] === null,
    ),
  );
}

function normalizeUsername(username: string): string {
  return username.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function normalizeDn(distinguishedName: string): string {
  return distinguishedName.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new Error(message);
  return row;
}
