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
  type AuditEvent,
  type AuthenticatedIdentity,
  type BuiltInRoleDefinition,
  type ExternalIdentity,
  type Permission,
  type Project,
  type Role,
  type RoleScope,
  type User,
  type UserSession,
  type UserStatus,
} from "@autoforge/domain";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { SqliteDatabaseHandle } from "./database";
import { mapAuditEvent, mapProject, mapRole, mapUser, parsePermissions } from "./identity-mapper";
import {
  auditEvents,
  authBootstrapUses,
  externalIdentities,
  ldapConfigurations,
  ldapGroupMappings,
  projectRoleBindings,
  projects,
  roles,
  users,
  userSessions,
  userSystemRoles,
} from "./schema";

const SYSTEM_ADMIN_ROLE_ID = "00000000-0000-7000-8100-000000000001";

export class SqliteIdentityAccessRepository implements IdentityAccessRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async ensureBuiltInRoles(
    definitions: BuiltInRoleDefinition[],
    recordedAt: string,
  ): Promise<void> {
    this.handle.client.transaction(() => {
      for (const definition of definitions) {
        this.handle.db
          .insert(roles)
          .values({
            id: definition.id,
            key: definition.key,
            name: definition.name,
            description: definition.description,
            scope: definition.scope,
            builtIn: true,
            permissionsJson: JSON.stringify(definition.permissions),
            createdAt: recordedAt,
            updatedAt: recordedAt,
          })
          .onConflictDoUpdate({
            target: roles.id,
            set: {
              name: definition.name,
              description: definition.description,
              scope: definition.scope,
              builtIn: true,
              permissionsJson: JSON.stringify(definition.permissions),
              updatedAt: recordedAt,
            },
          })
          .run();
      }
    })();
  }

  async hasUsers(): Promise<boolean> {
    const row = this.handle.db.select({ value: count() }).from(users).get();
    return (row?.value ?? 0) > 0;
  }

  async bootstrapAdministrator(input: {
    tokenHash: string;
    user: CreateLocalUserRecord;
    systemRoleId: string;
    projectId: string;
    projectRoleId: string;
    recordedAt: string;
  }): Promise<User | null> {
    return this.handle.client.transaction(() => {
      const existing = this.handle.db.select({ value: count() }).from(users).get()?.value ?? 0;
      if (existing > 0) return null;
      const use = this.handle.db
        .insert(authBootstrapUses)
        .values({ tokenHash: input.tokenHash, usedAt: input.recordedAt })
        .onConflictDoNothing()
        .run();
      if (use.changes === 0) return null;
      const user = this.insertLocalUser(input.user);
      this.handle.db
        .insert(userSystemRoles)
        .values({
          userId: user.id,
          roleId: input.systemRoleId,
          source: "manual",
          assignedAt: input.recordedAt,
          assignedBy: user.id,
        })
        .run();
      this.handle.db
        .insert(projectRoleBindings)
        .values({
          userId: user.id,
          projectId: input.projectId,
          roleId: input.projectRoleId,
          source: "manual",
          assignedAt: input.recordedAt,
          assignedBy: user.id,
        })
        .run();
      return mapUser(user);
    })();
  }

  async findUserByUsername(normalizedUsername: string): Promise<StoredUserCredential | null> {
    const row = this.handle.db
      .select()
      .from(users)
      .where(eq(users.normalizedUsername, normalizedUsername))
      .get();
    if (!row) return null;
    return {
      user: mapUser(row),
      ...(row.passwordHash ? { passwordHash: row.passwordHash } : {}),
    };
  }

  async findUser(userId: string): Promise<User | null> {
    const row = this.handle.db.select().from(users).where(eq(users.id, userId)).get();
    return row ? mapUser(row) : null;
  }

  async findExternalIdentity(
    providerId: string,
    subject: string,
  ): Promise<ExternalIdentity | null> {
    const row = this.handle.db
      .select()
      .from(externalIdentities)
      .where(
        and(eq(externalIdentities.providerId, providerId), eq(externalIdentities.subject, subject)),
      )
      .get();
    return row
      ? {
          id: row.id,
          userId: row.userId,
          providerId: row.providerId,
          subject: row.subject,
          directoryUsername: row.directoryUsername,
          attributes: stringRecord(row.attributesJson),
          synchronizedAt: row.synchronizedAt,
        }
      : null;
  }

  async upsertLdapUser(input: CreateLdapUserRecord): Promise<User> {
    return this.handle.client.transaction(() => {
      const normalizedUsername = normalizeUsername(input.identity.username);
      const external = this.handle.db
        .select()
        .from(externalIdentities)
        .where(
          and(
            eq(externalIdentities.providerId, input.providerId),
            eq(externalIdentities.subject, input.identity.subject),
          ),
        )
        .get();
      let userRow: typeof users.$inferSelect;
      if (external) {
        const updated = this.handle.db
          .update(users)
          .set({
            username: input.identity.username,
            normalizedUsername,
            displayName: input.identity.displayName,
            email: input.identity.email ?? null,
            status: "active",
            updatedAt: input.synchronizedAt,
            version: sql`${users.version} + 1`,
          })
          .where(and(eq(users.id, external.userId), eq(users.source, "ldap")))
          .returning()
          .get();
        if (!updated) throw new DomainError("IDENTITY_CONFLICT", "LDAP 身份关联的用户无效。");
        userRow = updated;
        this.handle.db
          .update(externalIdentities)
          .set({
            directoryUsername: input.identity.username,
            attributesJson: JSON.stringify(input.identity.attributes),
            synchronizedAt: input.synchronizedAt,
          })
          .where(eq(externalIdentities.id, external.id))
          .run();
      } else {
        const collision = this.handle.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.normalizedUsername, normalizedUsername))
          .get();
        if (collision) {
          throw new DomainError(
            "IDENTITY_CONFLICT",
            "LDAP 用户名与已有账号冲突，需要管理员显式处理。",
          );
        }
        userRow = this.handle.db
          .insert(users)
          .values({
            id: input.userId,
            username: input.identity.username,
            normalizedUsername,
            displayName: input.identity.displayName,
            email: input.identity.email ?? null,
            source: "ldap",
            status: "active",
            passwordHash: null,
            passwordUpdatedAt: null,
            forcePasswordChange: false,
            failedLoginAttempts: 0,
            lockedUntil: null,
            lastLoginAt: null,
            createdAt: input.synchronizedAt,
            updatedAt: input.synchronizedAt,
            version: 1,
          })
          .returning()
          .get();
        this.handle.db
          .insert(externalIdentities)
          .values({
            id: input.externalIdentityId,
            userId: input.userId,
            providerId: input.providerId,
            subject: input.identity.subject,
            directoryUsername: input.identity.username,
            attributesJson: JSON.stringify(input.identity.attributes),
            synchronizedAt: input.synchronizedAt,
          })
          .run();
      }
      return mapUser(userRow);
    })();
  }

  async recordLoginFailure(
    userId: string,
    failedAttempts: number,
    lockedUntil: string | undefined,
    recordedAt: string,
  ): Promise<void> {
    this.handle.db
      .update(users)
      .set({
        failedLoginAttempts: failedAttempts,
        lockedUntil: lockedUntil ?? null,
        updatedAt: recordedAt,
        version: sql`${users.version} + 1`,
      })
      .where(eq(users.id, userId))
      .run();
  }

  async createSessionAfterLogin(input: {
    id: string;
    userId: string;
    tokenHash: string;
    createdAt: string;
    expiresAt: string;
  }): Promise<User> {
    return this.handle.client.transaction(() => {
      const user = this.handle.db
        .update(users)
        .set({
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: input.createdAt,
          updatedAt: input.createdAt,
          version: sql`${users.version} + 1`,
        })
        .where(and(eq(users.id, input.userId), eq(users.status, "active")))
        .returning()
        .get();
      if (!user) throw new DomainError("AUTHENTICATION_FAILED", "用户名或密码无效。");
      this.handle.db
        .insert(userSessions)
        .values({
          id: input.id,
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          lastSeenAt: input.createdAt,
          createdAt: input.createdAt,
          revokedAt: null,
        })
        .run();
      return mapUser(user);
    })();
  }

  async resolveSession(tokenHash: string, now: string): Promise<AuthenticatedIdentity | null> {
    const session = this.handle.db
      .select()
      .from(userSessions)
      .where(
        and(
          eq(userSessions.tokenHash, tokenHash),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, now),
        ),
      )
      .get();
    if (!session) return null;
    const user = this.handle.db.select().from(users).where(eq(users.id, session.userId)).get();
    if (!user || user.status !== "active") return null;
    const systemRows = this.handle.db
      .select({ permissionsJson: roles.permissionsJson })
      .from(userSystemRoles)
      .innerJoin(roles, eq(roles.id, userSystemRoles.roleId))
      .where(eq(userSystemRoles.userId, user.id))
      .all();
    const projectRows = this.handle.db
      .select({ projectId: projectRoleBindings.projectId, permissionsJson: roles.permissionsJson })
      .from(projectRoleBindings)
      .innerJoin(roles, eq(roles.id, projectRoleBindings.roleId))
      .where(eq(projectRoleBindings.userId, user.id))
      .all();
    const projectPermissions: Record<string, Permission[]> = {};
    for (const row of projectRows) {
      projectPermissions[row.projectId] = mergePermissions(
        projectPermissions[row.projectId] ?? [],
        parsePermissions(row.permissionsJson),
      );
    }
    this.handle.db
      .update(userSessions)
      .set({ lastSeenAt: now })
      .where(eq(userSessions.id, session.id))
      .run();
    return {
      user: mapUser(user),
      sessionId: session.id,
      systemPermissions: mergePermissions(
        [],
        systemRows.flatMap((row) => parsePermissions(row.permissionsJson)),
      ),
      projectPermissions,
    };
  }

  async touchSession(sessionId: string, touchedAt: string): Promise<void> {
    this.handle.db
      .update(userSessions)
      .set({ lastSeenAt: touchedAt })
      .where(eq(userSessions.id, sessionId))
      .run();
  }

  async revokeSession(sessionId: string, revokedAt: string): Promise<void> {
    this.handle.db
      .update(userSessions)
      .set({ revokedAt })
      .where(and(eq(userSessions.id, sessionId), isNull(userSessions.revokedAt)))
      .run();
  }

  async revokeUserSessions(userId: string, revokedAt: string): Promise<void> {
    this.handle.db
      .update(userSessions)
      .set({ revokedAt })
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
      .run();
  }

  async revokeUserSessionsForRole(roleId: string, revokedAt: string): Promise<void> {
    const systemUserIds = this.handle.db
      .select({ userId: userSystemRoles.userId })
      .from(userSystemRoles)
      .where(eq(userSystemRoles.roleId, roleId))
      .all()
      .map((row) => row.userId);
    const projectUserIds = this.handle.db
      .select({ userId: projectRoleBindings.userId })
      .from(projectRoleBindings)
      .where(eq(projectRoleBindings.roleId, roleId))
      .all()
      .map((row) => row.userId);
    const userIds = [...new Set([...systemUserIds, ...projectUserIds])];
    if (userIds.length === 0) return;
    this.handle.db
      .update(userSessions)
      .set({ revokedAt })
      .where(and(inArray(userSessions.userId, userIds), isNull(userSessions.revokedAt)))
      .run();
  }

  async listUserSessions(userId: string, now: string): Promise<UserSession[]> {
    return this.handle.db
      .select()
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, userId),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, now),
        ),
      )
      .orderBy(desc(userSessions.lastSeenAt))
      .all()
      .map(mapUserSession);
  }

  async findSession(sessionId: string): Promise<UserSession | null> {
    const row = this.handle.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, sessionId))
      .get();
    return row ? mapUserSession(row) : null;
  }

  async listUsers(input: {
    query?: string;
    source?: "local" | "ldap";
    cursor?: string;
    limit: number;
  }): Promise<IdentityListPage> {
    const conditions: SQL[] = [];
    if (input.query) {
      const pattern = `%${input.query.trim()}%`;
      const search = or(like(users.username, pattern), like(users.displayName, pattern));
      if (search) conditions.push(search);
    }
    if (input.source) conditions.push(eq(users.source, input.source));
    if (input.cursor) conditions.push(lt(users.id, input.cursor));
    const rows = this.handle.db
      .select()
      .from(users)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(users.id))
      .limit(input.limit + 1)
      .all();
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map(mapUser),
      ...(rows.length > input.limit && last ? { nextCursor: last.id } : {}),
    };
  }

  async createLocalUser(record: CreateLocalUserRecord): Promise<User> {
    const existing = await this.findUserByUsername(record.normalizedUsername);
    if (existing) throw new DomainError("USER_CONFLICT", "用户名已存在。");
    return mapUser(this.insertLocalUser(record));
  }

  async updateUserStatus(userId: string, status: UserStatus, updatedAt: string): Promise<User> {
    return this.handle.client.transaction(() => {
      if (status === "disabled") this.ensureNotLastAdministrator(userId);
      const row = this.handle.db
        .update(users)
        .set({
          status,
          ...(status === "active" ? { failedLoginAttempts: 0, lockedUntil: null } : {}),
          updatedAt,
          version: sql`${users.version} + 1`,
        })
        .where(eq(users.id, userId))
        .returning()
        .get();
      if (!row) throw new DomainError("USER_NOT_FOUND", "指定用户不存在。");
      return mapUser(row);
    })();
  }

  async resetPassword(
    userId: string,
    passwordHash: string,
    forcePasswordChange: boolean,
    updatedAt: string,
  ): Promise<User> {
    const row = this.handle.db
      .update(users)
      .set({
        passwordHash,
        passwordUpdatedAt: updatedAt,
        forcePasswordChange,
        failedLoginAttempts: 0,
        lockedUntil: null,
        updatedAt,
        version: sql`${users.version} + 1`,
      })
      .where(and(eq(users.id, userId), eq(users.source, "local")))
      .returning()
      .get();
    if (!row) throw new DomainError("USER_NOT_FOUND", "指定本地用户不存在。");
    return mapUser(row);
  }

  async listRoles(): Promise<Role[]> {
    return this.handle.db.select().from(roles).orderBy(roles.scope, roles.key).all().map(mapRole);
  }

  async findRole(roleId: string): Promise<Role | null> {
    const row = this.handle.db.select().from(roles).where(eq(roles.id, roleId)).get();
    return row ? mapRole(row) : null;
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
    const conflict = this.handle.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, input.key))
      .get();
    if (conflict) throw new DomainError("ROLE_CONFLICT", "角色标识已存在。");
    const row = this.handle.db
      .insert(roles)
      .values({
        id: input.id,
        key: input.key,
        name: input.name,
        description: input.description,
        scope: input.scope,
        builtIn: false,
        permissionsJson: JSON.stringify(input.permissions),
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      .returning()
      .get();
    return mapRole(row);
  }

  async updateRole(input: {
    id: string;
    name?: string;
    description?: string;
    scope?: RoleScope;
    permissions?: Permission[];
    updatedAt: string;
  }): Promise<Role> {
    const row = this.handle.db
      .update(roles)
      .set({
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.permissions ? { permissionsJson: JSON.stringify(input.permissions) } : {}),
        updatedAt: input.updatedAt,
      })
      .where(and(eq(roles.id, input.id), eq(roles.builtIn, false)))
      .returning()
      .get();
    if (!row) throw new DomainError("ROLE_NOT_FOUND", "指定自定义角色不存在。");
    return mapRole(row);
  }

  async deleteRole(roleId: string): Promise<boolean> {
    const referenced =
      (this.handle.db
        .select({ value: count() })
        .from(userSystemRoles)
        .where(eq(userSystemRoles.roleId, roleId))
        .get()?.value ?? 0) +
      (this.handle.db
        .select({ value: count() })
        .from(projectRoleBindings)
        .where(eq(projectRoleBindings.roleId, roleId))
        .get()?.value ?? 0);
    if (referenced > 0) throw new DomainError("ROLE_IN_USE", "仍被分配的角色不能删除。");
    return (
      this.handle.db
        .delete(roles)
        .where(and(eq(roles.id, roleId), eq(roles.builtIn, false)))
        .run().changes > 0
    );
  }

  async assignSystemRole(
    userId: string,
    roleId: string,
    actorId: string,
    assignedAt: string,
  ): Promise<void> {
    this.handle.db
      .insert(userSystemRoles)
      .values({ userId, roleId, source: "manual", assignedAt, assignedBy: actorId })
      .onConflictDoUpdate({
        target: [userSystemRoles.userId, userSystemRoles.roleId],
        set: { source: "manual", assignedAt, assignedBy: actorId },
      })
      .run();
  }

  async assignProjectRole(input: {
    userId: string;
    projectId: string;
    roleId: string;
    actorId: string;
    assignedAt: string;
  }): Promise<void> {
    this.handle.db
      .insert(projectRoleBindings)
      .values({
        userId: input.userId,
        projectId: input.projectId,
        roleId: input.roleId,
        source: "manual",
        assignedAt: input.assignedAt,
        assignedBy: input.actorId,
      })
      .onConflictDoUpdate({
        target: [
          projectRoleBindings.userId,
          projectRoleBindings.projectId,
          projectRoleBindings.roleId,
        ],
        set: { source: "manual", assignedAt: input.assignedAt, assignedBy: input.actorId },
      })
      .run();
  }

  async removeSystemRole(userId: string, roleId: string): Promise<boolean> {
    return this.handle.client.transaction(() => {
      if (roleId === SYSTEM_ADMIN_ROLE_ID) this.ensureNotLastAdministrator(userId);
      return (
        this.handle.db
          .delete(userSystemRoles)
          .where(and(eq(userSystemRoles.userId, userId), eq(userSystemRoles.roleId, roleId)))
          .run().changes > 0
      );
    })();
  }

  async removeProjectRole(userId: string, projectId: string, roleId: string): Promise<boolean> {
    return (
      this.handle.db
        .delete(projectRoleBindings)
        .where(
          and(
            eq(projectRoleBindings.userId, userId),
            eq(projectRoleBindings.projectId, projectId),
            eq(projectRoleBindings.roleId, roleId),
          ),
        )
        .run().changes > 0
    );
  }

  async listProjectMemberships(
    projectId: string,
  ): Promise<Array<{ user: User; roleIds: string[] }>> {
    const rows = this.handle.db
      .select({ user: users, roleId: projectRoleBindings.roleId })
      .from(projectRoleBindings)
      .innerJoin(users, eq(users.id, projectRoleBindings.userId))
      .where(eq(projectRoleBindings.projectId, projectId))
      .orderBy(users.displayName)
      .all();
    const memberships = new Map<string, { user: User; roleIds: string[] }>();
    for (const row of rows) {
      const membership = memberships.get(row.user.id) ?? { user: mapUser(row.user), roleIds: [] };
      membership.roleIds.push(row.roleId);
      memberships.set(row.user.id, membership);
    }
    return [...memberships.values()];
  }

  async listProjects(): Promise<Project[]> {
    return this.handle.db.select().from(projects).orderBy(projects.name).all().map(mapProject);
  }

  async createProject(input: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
  }): Promise<Project> {
    const row = this.handle.db
      .insert(projects)
      .values({
        id: input.id,
        name: input.name,
        slug: input.slug,
        isDefault: false,
        archived: false,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      .returning()
      .get();
    return mapProject(row);
  }

  async archiveProject(projectId: string, archivedAt: string): Promise<Project> {
    const row = this.handle.db
      .update(projects)
      .set({ archived: true, updatedAt: archivedAt })
      .where(eq(projects.id, projectId))
      .returning()
      .get();
    if (!row) throw new DomainError("PROJECT_NOT_FOUND", "指定项目不存在。");
    return mapProject(row);
  }

  async getLdapConfiguration(): Promise<StoredLdapConfiguration | null> {
    const row = this.handle.db
      .select()
      .from(ldapConfigurations)
      .where(eq(ldapConfigurations.id, "default"))
      .get();
    return row ? mapLdapConfiguration(row) : null;
  }

  async saveLdapConfiguration(
    input: Omit<StoredLdapConfiguration, "createdAt" | "updatedAt" | "version"> & {
      updatedAt: string;
    },
  ): Promise<StoredLdapConfiguration> {
    const row = this.handle.db
      .insert(ldapConfigurations)
      .values(ldapConfigurationValues(input, input.updatedAt))
      .onConflictDoUpdate({
        target: ldapConfigurations.id,
        set: {
          ...ldapConfigurationValues(input, input.updatedAt),
          version: sql`${ldapConfigurations.version} + 1`,
        },
      })
      .returning()
      .get();
    return mapLdapConfiguration(row);
  }

  async listLdapGroupMappings(): Promise<
    Array<{ id: string; groupDn: string; roleId: string; projectId?: string; priority: number }>
  > {
    return this.handle.db
      .select()
      .from(ldapGroupMappings)
      .orderBy(desc(ldapGroupMappings.priority), ldapGroupMappings.createdAt)
      .all()
      .map((row) => ({
        id: row.id,
        groupDn: row.groupDn,
        roleId: row.roleId,
        ...(row.projectId ? { projectId: row.projectId } : {}),
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
    this.handle.db
      .insert(ldapGroupMappings)
      .values({
        id: input.id,
        groupDn: input.groupDn,
        normalizedGroupDn: input.normalizedGroupDn,
        roleId: input.roleId,
        projectId: input.projectId ?? null,
        priority: input.priority,
        createdAt: input.recordedAt,
        updatedAt: input.recordedAt,
      })
      .run();
  }

  async replaceLdapRoleBindings(input: {
    userId: string;
    groupDns: string[];
    mappings: Array<{ groupDn: string; roleId: string; projectId?: string; priority: number }>;
    recordedAt: string;
  }): Promise<void> {
    this.handle.client.transaction(() => {
      this.handle.db
        .delete(userSystemRoles)
        .where(and(eq(userSystemRoles.userId, input.userId), eq(userSystemRoles.source, "ldap")))
        .run();
      this.handle.db
        .delete(projectRoleBindings)
        .where(
          and(eq(projectRoleBindings.userId, input.userId), eq(projectRoleBindings.source, "ldap")),
        )
        .run();
      const groups = new Set(input.groupDns);
      for (const mapping of input.mappings) {
        if (!groups.has(normalizeDn(mapping.groupDn))) continue;
        if (mapping.projectId) {
          this.handle.db
            .insert(projectRoleBindings)
            .values({
              userId: input.userId,
              projectId: mapping.projectId,
              roleId: mapping.roleId,
              source: "ldap",
              assignedAt: input.recordedAt,
              assignedBy: null,
            })
            .onConflictDoNothing()
            .run();
        } else {
          this.handle.db
            .insert(userSystemRoles)
            .values({
              userId: input.userId,
              roleId: mapping.roleId,
              source: "ldap",
              assignedAt: input.recordedAt,
              assignedBy: null,
            })
            .onConflictDoNothing()
            .run();
        }
      }
    })();
  }

  async disableMissingLdapUsers(input: {
    providerId: string;
    activeSubjects: string[];
    recordedAt: string;
  }): Promise<string[]> {
    return this.handle.client.transaction(() => {
      const externalRows = this.handle.db
        .select({ userId: externalIdentities.userId, subject: externalIdentities.subject })
        .from(externalIdentities)
        .innerJoin(users, eq(users.id, externalIdentities.userId))
        .where(and(eq(externalIdentities.providerId, input.providerId), eq(users.status, "active")))
        .all();
      const activeSubjects = new Set(input.activeSubjects);
      const userIds = externalRows
        .filter((identity) => !activeSubjects.has(identity.subject))
        .map((identity) => identity.userId);
      if (userIds.length === 0) return [];
      this.handle.db
        .update(users)
        .set({
          status: "disabled",
          updatedAt: input.recordedAt,
          version: sql`${users.version} + 1`,
        })
        .where(inArray(users.id, userIds))
        .run();
      this.handle.db
        .update(userSessions)
        .set({ revokedAt: input.recordedAt })
        .where(and(inArray(userSessions.userId, userIds), isNull(userSessions.revokedAt)))
        .run();
      return userIds;
    })();
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.handle.db
      .insert(auditEvents)
      .values({
        id: event.id,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId ?? null,
        projectId: event.projectId ?? null,
        result: event.result,
        requestId: event.requestId ?? null,
        detailsJson: JSON.stringify(event.details),
        recordedAt: event.recordedAt,
      })
      .run();
  }

  async listAudit(input: {
    actorId?: string;
    action?: string;
    resourceType?: string;
    result?: AuditEvent["result"];
    recordedAfter?: string;
    recordedBefore?: string;
    cursor?: string;
    limit: number;
  }): Promise<AuditListPage> {
    const conditions: SQL[] = [];
    if (input.actorId) conditions.push(eq(auditEvents.actorId, input.actorId));
    if (input.action) conditions.push(eq(auditEvents.action, input.action));
    if (input.resourceType) conditions.push(eq(auditEvents.resourceType, input.resourceType));
    if (input.result) conditions.push(eq(auditEvents.result, input.result));
    if (input.recordedAfter) conditions.push(gt(auditEvents.recordedAt, input.recordedAfter));
    if (input.recordedBefore) conditions.push(lt(auditEvents.recordedAt, input.recordedBefore));
    if (input.cursor) conditions.push(lt(auditEvents.id, input.cursor));
    const rows = this.handle.db
      .select()
      .from(auditEvents)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditEvents.recordedAt), desc(auditEvents.id))
      .limit(input.limit + 1)
      .all();
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map(mapAuditEvent),
      ...(rows.length > input.limit && last ? { nextCursor: last.id } : {}),
    };
  }

  private insertLocalUser(record: CreateLocalUserRecord) {
    return this.handle.db
      .insert(users)
      .values({
        id: record.id,
        username: record.username,
        normalizedUsername: record.normalizedUsername,
        displayName: record.displayName,
        email: record.email ?? null,
        source: "local",
        status: "active",
        passwordHash: record.passwordHash,
        passwordUpdatedAt: record.createdAt,
        forcePasswordChange: record.forcePasswordChange,
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: null,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
        version: 1,
      })
      .returning()
      .get();
  }

  private ensureNotLastAdministrator(userId: string): void {
    const targetIsAdministrator = Boolean(
      this.handle.db
        .select({ userId: userSystemRoles.userId })
        .from(userSystemRoles)
        .where(
          and(eq(userSystemRoles.userId, userId), eq(userSystemRoles.roleId, SYSTEM_ADMIN_ROLE_ID)),
        )
        .get(),
    );
    if (!targetIsAdministrator) return;
    const activeAdministrators = this.handle.db
      .select({ value: count() })
      .from(userSystemRoles)
      .innerJoin(users, eq(users.id, userSystemRoles.userId))
      .where(and(eq(userSystemRoles.roleId, SYSTEM_ADMIN_ROLE_ID), eq(users.status, "active")))
      .get()?.value;
    if ((activeAdministrators ?? 0) <= 1) {
      throw new DomainError("LAST_ADMIN_REQUIRED", "不能禁用最后一位系统管理员。");
    }
  }
}

function mapUserSession(row: typeof userSessions.$inferSelect): UserSession {
  return {
    id: row.id,
    userId: row.userId,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
  };
}

function ldapConfigurationValues(
  input: Omit<StoredLdapConfiguration, "createdAt" | "updatedAt" | "version"> & {
    updatedAt: string;
  },
  createdAt: string,
) {
  return {
    id: "default",
    enabled: input.enabled,
    urlsJson: JSON.stringify(input.urls),
    tlsMode: input.tlsMode,
    caPem: input.caPem ?? null,
    connectTimeoutMs: input.connectTimeoutMs,
    operationTimeoutMs: input.operationTimeoutMs,
    pageSize: input.pageSize,
    maximumUsers: input.maximumUsers,
    bindDn: input.bindDn,
    bindPasswordEncrypted: input.bindPasswordEncrypted ?? null,
    userBaseDn: input.userBaseDn,
    userFilter: input.userFilter,
    userIdAttribute: input.userIdAttribute,
    usernameAttribute: input.usernameAttribute,
    displayNameAttribute: input.displayNameAttribute,
    emailAttribute: input.emailAttribute,
    groupBaseDn: input.groupBaseDn ?? null,
    groupFilter: input.groupFilter ?? null,
    groupMemberAttribute: input.groupMemberAttribute,
    createdAt,
    updatedAt: input.updatedAt,
    version: 1,
  };
}

function mapLdapConfiguration(
  row: typeof ldapConfigurations.$inferSelect,
): StoredLdapConfiguration {
  return {
    enabled: row.enabled,
    urls: stringArray(row.urlsJson),
    tlsMode: row.tlsMode,
    ...(row.caPem ? { caPem: row.caPem } : {}),
    connectTimeoutMs: row.connectTimeoutMs,
    operationTimeoutMs: row.operationTimeoutMs,
    pageSize: row.pageSize,
    maximumUsers: row.maximumUsers,
    bindDn: row.bindDn,
    ...(row.bindPasswordEncrypted ? { bindPasswordEncrypted: row.bindPasswordEncrypted } : {}),
    userBaseDn: row.userBaseDn,
    userFilter: row.userFilter,
    userIdAttribute: row.userIdAttribute,
    usernameAttribute: row.usernameAttribute,
    displayNameAttribute: row.displayNameAttribute,
    emailAttribute: row.emailAttribute,
    ...(row.groupBaseDn ? { groupBaseDn: row.groupBaseDn } : {}),
    ...(row.groupFilter ? { groupFilter: row.groupFilter } : {}),
    groupMemberAttribute: row.groupMemberAttribute,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
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

function normalizeUsername(username: string): string {
  return username.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function normalizeDn(distinguishedName: string): string {
  return distinguishedName.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
