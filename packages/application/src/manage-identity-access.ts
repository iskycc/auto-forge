import type {
  BootstrapAdminInput,
  CreateProjectInput,
  CreateRoleInput,
  CreateUserInput,
  LdapConfigurationInput,
  LoginInput,
  TransferProjectOwnerInput,
  UpdateRoleInput,
} from "@autoforge/contracts";
import {
  builtInRoleDefinitions,
  countSystemAdministrators,
  DEFAULT_PROJECT_ID,
  DomainError,
  hasPermission,
  projectIdsForPermission,
  isPermission,
  type AuditEvent,
  type AuthenticatedIdentity,
  type Permission,
  type UserStatus,
  type UserSession,
} from "@autoforge/domain";

import type {
  Clock,
  DirectoryConfiguration,
  DirectoryIdentity,
  DirectoryPort,
  IdGenerator,
  IdentityAccessRepository,
  IdentityTokenPort,
  PasswordHashPort,
  SecretCipherPort,
  StoredLdapConfiguration,
  StoredUserCredential,
} from "./ports";

const SYSTEM_ADMIN_ROLE_ID = "00000000-0000-7000-8100-000000000001";
const PROJECT_ADMIN_ROLE_ID = "00000000-0000-7000-8100-000000000002";
const TEST_MANAGER_ROLE_ID = "00000000-0000-7000-8100-000000000003";
const VIEWER_ROLE_ID = "00000000-0000-7000-8100-000000000005";
const LDAP_PROVIDER_ID = "ldap:default";
const MAXIMUM_FAILED_LOGINS = 5;
const LOGIN_LOCK_MINUTES = 15;
const DUMMY_PASSWORD_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export type SessionResult = {
  token: string;
  expiresAt: string;
  userId: string;
};

type AuditInput = {
  actorId?: string | undefined;
  action: string;
  resourceType: string;
  resourceId?: string | undefined;
  projectId?: string | undefined;
  result: AuditEvent["result"];
  requestId?: string | undefined;
  details: AuditEvent["details"];
};

export class IdentityAccessService {
  constructor(
    private readonly repository: IdentityAccessRepository,
    private readonly passwords: PasswordHashPort,
    private readonly tokens: IdentityTokenPort,
    private readonly cipher: SecretCipherPort,
    private readonly directory: DirectoryPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly sessionTtlHours: number,
    private readonly readModelInvalidation?: { invalidate(projectId: string): Promise<void> },
  ) {}

  async initialize(): Promise<void> {
    await this.repository.ensureBuiltInRoles(builtInRoleDefinitions, this.now());
  }

  async setupRequired(): Promise<boolean> {
    return !(await this.repository.hasUsers());
  }

  async authorizeBootstrapConfiguration(bootstrapToken: string, requestId?: string): Promise<void> {
    const allowed =
      this.tokens.verifyBootstrapToken(bootstrapToken) && (await this.setupRequired());
    if (!allowed) {
      await this.audit({
        action: "settings.platform.bootstrap",
        resourceType: "platform_configuration",
        result: "rejected",
        requestId,
        details: { reason: "invalid_or_initialized" },
      });
      throw new DomainError(
        "AUTH_BOOTSTRAP_REJECTED",
        "管理员引导令牌无效，或平台已经完成初始化。",
      );
    }
  }

  async recordBootstrapConfiguration(
    input: { mode: "lite" | "full"; revision: number },
    requestId?: string,
  ): Promise<void> {
    await this.audit({
      action: "settings.platform.bootstrap",
      resourceType: "platform_configuration",
      result: "succeeded",
      requestId,
      details: { ...input, restartRequired: true },
    });
  }

  async bootstrap(input: BootstrapAdminInput, requestId?: string): Promise<SessionResult> {
    if (!this.tokens.verifyBootstrapToken(input.bootstrapToken)) {
      await this.audit({
        action: "auth.bootstrap",
        resourceType: "user",
        result: "rejected",
        requestId,
        details: { reason: "invalid_bootstrap_token" },
      });
      throw new DomainError("AUTH_BOOTSTRAP_REJECTED", "管理员引导令牌无效或已使用。");
    }
    const createdAt = this.now();
    const passwordHash = await this.passwords.hash(input.password);
    const user = await this.repository.bootstrapAdministrator({
      tokenHash: this.tokens.hash(input.bootstrapToken),
      user: {
        id: this.ids.next(),
        username: input.username,
        normalizedUsername: normalizeUsername(input.username),
        displayName: input.displayName,
        passwordHash,
        forcePasswordChange: false,
        createdAt,
      },
      systemRoleId: SYSTEM_ADMIN_ROLE_ID,
      projectId: DEFAULT_PROJECT_ID,
      projectRoleId: PROJECT_ADMIN_ROLE_ID,
      recordedAt: createdAt,
    });
    if (!user) {
      await this.audit({
        action: "auth.bootstrap",
        resourceType: "user",
        result: "rejected",
        requestId,
        details: { reason: "already_initialized" },
      });
      throw new DomainError("AUTH_BOOTSTRAP_REJECTED", "管理员引导令牌无效或已使用。");
    }
    await this.audit({
      actorId: user.id,
      action: "auth.bootstrap",
      resourceType: "user",
      resourceId: user.id,
      result: "succeeded",
      requestId,
      details: { source: "local" },
    });
    return this.createSession(user.id);
  }

  async login(input: LoginInput, requestId?: string): Promise<SessionResult> {
    const credential = await this.repository.findUserByUsername(normalizeUsername(input.username));
    if (credential?.user.source === "local") {
      return this.loginLocally(input.password, credential, requestId);
    }
    if (credential?.user.source === "ldap" && credential.user.status !== "active") {
      return this.rejectedLogin("ldap", credential.user.id, requestId);
    }
    const ldapConfiguration = await this.repository.getLdapConfiguration();
    if (credential?.user.source === "ldap" || ldapConfiguration?.enabled) {
      return this.loginWithLdap(input.username, input.password, ldapConfiguration, requestId);
    }
    return this.loginLocally(input.password, null, requestId);
  }

  async authenticateSession(token: string): Promise<AuthenticatedIdentity> {
    if (!token) throw new DomainError("AUTH_REQUIRED", "请先登录。");
    const identity = await this.repository.resolveSession(this.tokens.hash(token), this.now());
    if (!identity || identity.user.status !== "active") {
      throw new DomainError("AUTH_REQUIRED", "登录会话无效或已过期。");
    }
    return identity;
  }

  async refreshSession(identity: AuthenticatedIdentity): Promise<{ expiresAt: string }> {
    const refreshedAt = this.clock.now();
    const expiresAt = new Date(
      refreshedAt.getTime() + this.sessionTtlHours * 60 * 60 * 1_000,
    ).toISOString();
    const renewed = await this.repository.renewSession({
      sessionId: identity.sessionId,
      refreshedAt: refreshedAt.toISOString(),
      expiresAt,
    });
    if (!renewed) {
      throw new DomainError("AUTH_REQUIRED", "登录会话无效、已过期或已被撤销。");
    }
    return { expiresAt };
  }

  authorize(identity: AuthenticatedIdentity, permission: Permission, projectId?: string): void {
    if (!hasPermission(identity, permission, projectId)) {
      throw new DomainError("AUTH_FORBIDDEN", "当前账号没有执行此操作的权限。");
    }
  }

  projectScope(identity: AuthenticatedIdentity, permission: Permission): string[] | undefined {
    const projectIds = projectIdsForPermission(identity, permission);
    if (!projectIds) return undefined;
    if (projectIds.length === 0) {
      throw new DomainError("AUTH_FORBIDDEN", "当前账号没有执行此操作的权限。");
    }
    return projectIds;
  }

  async logout(identity: AuthenticatedIdentity, requestId?: string): Promise<void> {
    const revokedAt = this.now();
    await this.repository.revokeSession(identity.sessionId, revokedAt);
    await this.audit({
      actorId: identity.user.id,
      action: "auth.logout",
      resourceType: "session",
      resourceId: identity.sessionId,
      result: "succeeded",
      requestId,
      details: {},
    });
  }

  async listUsers(
    actor: AuthenticatedIdentity,
    input: { query?: string; source?: "local" | "ldap"; cursor?: string; limit: number },
  ) {
    this.authorize(actor, "user.read");
    return this.repository.listUsers(input);
  }

  async listAnalysisAssignees(
    actor: AuthenticatedIdentity,
    input: { projectId: string; query?: string; cursor?: string; limit: number },
  ) {
    this.authorize(actor, "analysis.assign", input.projectId);
    const page = await this.repository.listUsers({
      analysisProjectId: input.projectId,
      ...(input.query ? { query: input.query.trim().slice(0, 240) } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: Math.max(1, Math.min(50, input.limit)),
    });
    return {
      ...page,
      items: page.items.map(({ id, username, displayName }) => ({ id, username, displayName })),
    };
  }

  async requireAnalysisAssignee(actor: AuthenticatedIdentity, projectId: string, userId: string) {
    this.authorize(actor, "analysis.assign", projectId);
    const page = await this.repository.listUsers({
      analysisProjectId: projectId,
      userId,
      limit: 1,
    });
    const user = page.items[0];
    if (!user) {
      throw new DomainError(
        "FAILURE_ANALYSIS_ASSIGNEE_UNAVAILABLE",
        "请选择已启用且对当前项目有执行读取和用例分析权限的用户。",
      );
    }
    return { id: user.id, username: user.username, displayName: user.displayName };
  }

  async createUser(actor: AuthenticatedIdentity, input: CreateUserInput, requestId?: string) {
    this.authorize(actor, "user.manage");
    const createdAt = this.now();
    const user = await this.repository.createLocalUser({
      id: this.ids.next(),
      username: input.username,
      normalizedUsername: normalizeUsername(input.username),
      displayName: input.displayName,
      ...(input.email ? { email: input.email } : {}),
      passwordHash: await this.passwords.hash(input.password),
      forcePasswordChange: input.forcePasswordChange,
      createdAt,
    });
    await this.audit({
      actorId: actor.user.id,
      action: "user.create",
      resourceType: "user",
      resourceId: user.id,
      result: "succeeded",
      requestId,
      details: { source: "local" },
    });
    return user;
  }

  async updateUserStatus(
    actor: AuthenticatedIdentity,
    userId: string,
    status: UserStatus,
    requestId?: string,
  ) {
    this.authorize(actor, "user.manage");
    if (actor.user.id === userId && status === "disabled") {
      throw new DomainError("USER_SELF_DISABLE_REJECTED", "不能禁用当前登录账号。");
    }
    const updatedAt = this.now();
    const user = await this.repository.updateUserStatus(userId, status, updatedAt);
    if (status === "disabled") await this.repository.revokeUserSessions(userId, updatedAt);
    await this.audit({
      actorId: actor.user.id,
      action: status === "disabled" ? "user.disable" : "user.enable",
      resourceType: "user",
      resourceId: userId,
      result: "succeeded",
      requestId,
      details: {},
    });
    return user;
  }

  async resetPassword(
    actor: AuthenticatedIdentity,
    userId: string,
    password: string,
    forcePasswordChange: boolean,
    requestId?: string,
  ) {
    this.authorize(actor, "user.manage");
    const existing = await this.requiredUser(userId);
    if (existing.source !== "local") {
      throw new DomainError("USER_PASSWORD_EXTERNAL", "LDAP 用户密码必须在目录服务中修改。");
    }
    const updatedAt = this.now();
    const user = await this.repository.resetPassword(
      userId,
      await this.passwords.hash(password),
      forcePasswordChange,
      updatedAt,
    );
    await this.repository.revokeUserSessions(userId, updatedAt);
    await this.audit({
      actorId: actor.user.id,
      action: "user.password_reset",
      resourceType: "user",
      resourceId: userId,
      result: "succeeded",
      requestId,
      details: { forcePasswordChange },
    });
    return user;
  }

  async revokeUserSessions(
    actor: AuthenticatedIdentity,
    userId: string,
    requestId?: string,
  ): Promise<void> {
    this.authorize(actor, "user.manage");
    await this.requiredUser(userId);
    const revokedAt = this.now();
    await this.repository.revokeUserSessions(userId, revokedAt);
    await this.audit({
      actorId: actor.user.id,
      action: "user.sessions_revoke",
      resourceType: "user",
      resourceId: userId,
      result: "succeeded",
      requestId,
      details: {},
    });
  }

  async changePassword(
    actor: AuthenticatedIdentity,
    currentPassword: string,
    newPassword: string,
    requestId?: string,
  ): Promise<void> {
    const credential = await this.repository.findUserByUsername(
      normalizeUsername(actor.user.username),
    );
    if (
      !credential?.passwordHash ||
      actor.user.source !== "local" ||
      !(await this.passwords.verify(currentPassword, credential.passwordHash))
    ) {
      throw new DomainError("AUTHENTICATION_FAILED", "当前密码无效。");
    }
    const changedAt = this.now();
    await this.repository.resetPassword(
      actor.user.id,
      await this.passwords.hash(newPassword),
      false,
      changedAt,
    );
    await this.repository.revokeUserSessions(actor.user.id, changedAt);
    await this.audit({
      actorId: actor.user.id,
      action: "user.password_change",
      resourceType: "user",
      resourceId: actor.user.id,
      result: "succeeded",
      requestId,
      details: {},
    });
  }

  async listSessions(
    actor: AuthenticatedIdentity,
    userId: string = actor.user.id,
  ): Promise<UserSession[]> {
    if (userId !== actor.user.id) this.authorize(actor, "user.manage");
    return this.repository.listUserSessions(userId, this.now());
  }

  async revokeManagedSession(
    actor: AuthenticatedIdentity,
    sessionId: string,
    requestId?: string,
  ): Promise<void> {
    const session = await this.repository.findSession(sessionId);
    if (!session) throw new DomainError("SESSION_NOT_FOUND", "指定会话不存在。");
    if (session.userId !== actor.user.id) this.authorize(actor, "user.manage");
    await this.repository.revokeSession(sessionId, this.now());
    await this.audit({
      actorId: actor.user.id,
      action: "session.revoke",
      resourceType: "session",
      resourceId: sessionId,
      result: "succeeded",
      requestId,
      details: { targetUserId: session.userId },
    });
  }

  async listRoles(actor: AuthenticatedIdentity) {
    this.authorize(actor, "role.read");
    return this.repository.listRoles();
  }

  async listProjectRolesForMemberManagement(actor: AuthenticatedIdentity, projectId: string) {
    this.authorize(actor, "project.read", projectId);
    return (await this.repository.listRoles()).filter(
      (role) => role.scope === "project" && role.active,
    );
  }

  async listSystemRoleBindingsPage(actor: AuthenticatedIdentity, cursor?: string) {
    this.authorize(actor, "role.read");
    const bindings = await this.repository.listSystemRoleBindings(undefined, {
      limit: 51,
      ...(cursor ? { afterUserId: cursor } : {}),
    });
    const userIds = [...new Set(bindings.map((binding) => binding.userId))];
    const selected = new Set(userIds.slice(0, 50));
    return {
      items: bindings.filter((binding) => selected.has(binding.userId)),
      nextCursor: userIds.length > 50 ? userIds[49] : undefined,
    };
  }

  async listSystemRoleBindings(actor: AuthenticatedIdentity, userIds?: readonly string[]) {
    this.authorize(actor, "role.read");
    return this.repository.listSystemRoleBindings(userIds);
  }

  async recordPlatformConfigurationChange(
    actor: AuthenticatedIdentity,
    input: { mode: "lite" | "full"; revision: number },
    requestId?: string,
  ): Promise<void> {
    this.authorize(actor, "settings.manage");
    await this.audit({
      actorId: actor.user.id,
      action: "settings.platform.update",
      resourceType: "platform_configuration",
      result: "succeeded",
      requestId,
      details: { mode: input.mode, revision: input.revision, restartRequired: true },
    });
  }

  async recordQueueDeadLetterRedrive(
    actor: AuthenticatedIdentity,
    input: { redriven: number },
    requestId?: string,
  ): Promise<void> {
    this.authorize(actor, "settings.manage");
    await this.audit({
      actorId: actor.user.id,
      action: "settings.queue_dead_letter.redrive",
      resourceType: "job_queue",
      result: "succeeded",
      requestId,
      details: { redriven: input.redriven },
    });
  }

  async createRole(actor: AuthenticatedIdentity, input: CreateRoleInput, requestId?: string) {
    this.authorize(actor, "role.manage");
    const permissions = validatedPermissions(input.permissions);
    const createdAt = this.now();
    const role = await this.repository.createRole({
      id: this.ids.next(),
      key: input.key,
      name: input.name,
      description: input.description,
      scope: input.scope,
      permissions,
      createdAt,
    });
    await this.audit({
      actorId: actor.user.id,
      action: "role.create",
      resourceType: "role",
      resourceId: role.id,
      result: "succeeded",
      requestId,
      details: { scope: role.scope },
    });
    return role;
  }

  async updateRole(
    actor: AuthenticatedIdentity,
    roleId: string,
    input: UpdateRoleInput,
    requestId?: string,
  ) {
    this.authorize(actor, "role.manage");
    const existing = await this.requiredRole(roleId);
    if (existing.builtIn) {
      throw new DomainError("BUILT_IN_ROLE_IMMUTABLE", "内置角色不能修改。");
    }
    if (input.active === false) {
      await this.ensureSystemAdministratorsRemain({ roleId });
    }
    const role = await this.repository.updateRole({
      id: roleId,
      ...(input.name ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.permissions ? { permissions: validatedPermissions(input.permissions) } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: this.now(),
    });
    await this.repository.revokeUserSessionsForRole(roleId, this.now());
    await this.audit({
      actorId: actor.user.id,
      action: "role.update",
      resourceType: "role",
      resourceId: role.id,
      result: "succeeded",
      requestId,
      details: {
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.permissions ? { permissionCount: input.permissions.length } : {}),
      },
    });
    return role;
  }

  async deleteRole(
    actor: AuthenticatedIdentity,
    roleId: string,
    requestId?: string,
  ): Promise<void> {
    this.authorize(actor, "role.manage");
    const role = await this.requiredRole(roleId);
    if (role.builtIn) throw new DomainError("BUILT_IN_ROLE_IMMUTABLE", "内置角色不能删除。");
    if (!(await this.repository.deleteRole(roleId))) {
      throw new DomainError("ROLE_IN_USE", "仍被引用的角色不能删除。");
    }
    await this.audit({
      actorId: actor.user.id,
      action: "role.delete",
      resourceType: "role",
      resourceId: roleId,
      result: "succeeded",
      requestId,
      details: {},
    });
  }

  async assignSystemRole(
    actor: AuthenticatedIdentity,
    userId: string,
    roleId: string,
    requestId?: string,
  ): Promise<void> {
    this.authorize(actor, "role.manage");
    await this.requiredUser(userId);
    const role = await this.requiredRole(roleId);
    if (!role.active) {
      throw new DomainError("ROLE_INACTIVE", "已停用的角色不能分配。");
    }
    if (role.scope !== "system") {
      throw new DomainError("ROLE_SCOPE_INVALID", "项目角色不能分配为系统角色。");
    }
    const assignedAt = this.now();
    await this.repository.assignSystemRole(userId, roleId, actor.user.id, assignedAt);
    await this.repository.revokeUserSessions(userId, assignedAt);
    await this.audit({
      actorId: actor.user.id,
      action: "role.assign_system",
      resourceType: "user",
      resourceId: userId,
      result: "succeeded",
      requestId,
      details: { roleId },
    });
  }

  async assignProjectRole(
    actor: AuthenticatedIdentity,
    userId: string,
    projectId: string,
    roleId: string,
    requestId?: string,
  ): Promise<void> {
    this.authorize(actor, "project.manage", projectId);
    await this.requiredUser(userId);
    const role = await this.requiredRole(roleId);
    if (!role.active) {
      throw new DomainError("ROLE_INACTIVE", "已停用的角色不能分配。");
    }
    if (role.scope !== "project") {
      throw new DomainError("ROLE_SCOPE_INVALID", "系统角色不能分配为项目角色。");
    }
    const assignedAt = this.now();
    await this.repository.assignProjectRole({
      userId,
      projectId,
      roleId,
      actorId: actor.user.id,
      assignedAt,
    });
    await this.repository.revokeUserSessions(userId, assignedAt);
    await this.audit({
      actorId: actor.user.id,
      action: "role.assign_project",
      resourceType: "user",
      resourceId: userId,
      projectId,
      result: "succeeded",
      requestId,
      details: { roleId },
    });
  }

  async removeSystemRole(
    actor: AuthenticatedIdentity,
    userId: string,
    roleId: string,
    requestId?: string,
  ): Promise<void> {
    this.authorize(actor, "role.manage");
    await this.ensureSystemAdministratorsRemain({ userId, roleId });
    if (!(await this.repository.removeSystemRole(userId, roleId, this.now()))) {
      throw new DomainError("ROLE_BINDING_NOT_FOUND", "指定的系统角色绑定不存在。");
    }
    await this.repository.revokeUserSessions(userId, this.now());
    await this.audit({
      actorId: actor.user.id,
      action: "role.remove_system",
      resourceType: "user",
      resourceId: userId,
      result: "succeeded",
      requestId,
      details: { roleId },
    });
  }

  async removeProjectRole(
    actor: AuthenticatedIdentity,
    userId: string,
    projectId: string,
    roleId: string,
    requestId?: string,
  ): Promise<void> {
    this.authorize(actor, "project.manage", projectId);
    await this.ensureProjectOwnerCanStillManage(userId, projectId, roleId);
    if (!(await this.repository.removeProjectRole(userId, projectId, roleId))) {
      throw new DomainError("ROLE_BINDING_NOT_FOUND", "指定的项目角色绑定不存在。");
    }
    await this.repository.revokeUserSessions(userId, this.now());
    await this.audit({
      actorId: actor.user.id,
      action: "role.remove_project",
      resourceType: "user",
      resourceId: userId,
      projectId,
      result: "succeeded",
      requestId,
      details: { roleId },
    });
  }

  async listUserProjectRoleBindings(actor: AuthenticatedIdentity, userIds: readonly string[]) {
    this.authorize(actor, "user.read");
    const projectIds = this.projectScope(actor, "project.read");
    return this.repository.listUserProjectRoleBindings(userIds, projectIds);
  }

  async listProjectMembersPage(
    actor: AuthenticatedIdentity,
    projectId: string,
    input: { cursor?: string; query?: string; limit: number },
  ) {
    this.authorize(actor, "project.read", projectId);
    const limit = Math.max(1, Math.min(input.limit, 200));
    const members = await this.repository.listProjectMemberships(projectId, {
      limit: limit + 1,
      ...(input.cursor ? { afterUserId: input.cursor } : {}),
      ...(input.query ? { query: input.query } : {}),
    });
    const items = members.slice(0, limit);
    return {
      items,
      ...(members.length > limit && items.at(-1) ? { nextCursor: items.at(-1)!.user.id } : {}),
    };
  }

  async listProjectMembers(actor: AuthenticatedIdentity, projectId: string) {
    this.authorize(actor, "project.read", projectId);
    return this.repository.listProjectMemberships(projectId);
  }

  async listProjects(actor: AuthenticatedIdentity) {
    const projectIds = projectIdsForPermission(actor, "project.read");
    if (projectIds?.length === 0) {
      throw new DomainError("AUTH_FORBIDDEN", "当前账号没有读取项目的权限。");
    }
    return this.repository.listProjects(projectIds);
  }

  async createProject(actor: AuthenticatedIdentity, input: CreateProjectInput, requestId?: string) {
    this.authorize(actor, "project.manage");
    const project = await this.repository.createProject({
      id: this.ids.next(),
      name: input.name,
      slug: input.slug,
      ownerUserId: actor.user.id,
      createdAt: this.now(),
    });
    await this.audit({
      actorId: actor.user.id,
      action: "project.create",
      resourceType: "project",
      resourceId: project.id,
      projectId: project.id,
      result: "succeeded",
      requestId,
      details: { slug: project.slug },
    });
    return project;
  }

  async transferProjectOwner(
    actor: AuthenticatedIdentity,
    projectId: string,
    input: TransferProjectOwnerInput,
    requestId?: string,
  ) {
    this.authorize(actor, "project.manage", projectId);
    const owner = await this.requiredUser(input.ownerUserId);
    if (owner.status !== "active") {
      throw new DomainError("PROJECT_OWNER_INACTIVE", "项目负责人必须是启用状态的用户。");
    }
    if (!(await this.userCanManageProject(owner.id, projectId))) {
      await this.repository.assignProjectRole({
        userId: owner.id,
        projectId,
        roleId: PROJECT_ADMIN_ROLE_ID,
        actorId: actor.user.id,
        assignedAt: this.now(),
      });
      await this.repository.revokeUserSessions(owner.id, this.now());
    }
    const project = await this.repository.transferProjectOwner({
      projectId,
      ownerUserId: owner.id,
      updatedAt: this.now(),
    });
    await this.audit({
      actorId: actor.user.id,
      action: "project.transfer_owner",
      resourceType: "project",
      resourceId: projectId,
      projectId,
      result: "succeeded",
      requestId,
      details: { ownerUserId: owner.id },
    });
    return project;
  }

  async archiveProject(actor: AuthenticatedIdentity, projectId: string, requestId?: string) {
    this.authorize(actor, "project.manage", projectId);
    if (projectId === DEFAULT_PROJECT_ID) {
      throw new DomainError("DEFAULT_PROJECT_IMMUTABLE", "默认项目不能归档。");
    }
    const project = await this.repository.archiveProject(projectId, this.now());
    await this.audit({
      actorId: actor.user.id,
      action: "project.archive",
      resourceType: "project",
      resourceId: projectId,
      projectId,
      result: "succeeded",
      requestId,
      details: {},
    });
    return project;
  }

  async getLdapConfiguration(actor: AuthenticatedIdentity) {
    this.authorize(actor, "ldap.read");
    const configuration = await this.repository.getLdapConfiguration();
    return configuration
      ? publicLdapConfiguration(configuration)
      : defaultPublicLdapConfiguration();
  }

  async saveLdapConfiguration(
    actor: AuthenticatedIdentity,
    input: LdapConfigurationInput,
    requestId?: string,
  ) {
    this.authorize(actor, "ldap.manage");
    const existing = await this.repository.getLdapConfiguration();
    let bindPasswordEncrypted = existing?.bindPasswordEncrypted;
    if (input.clearBindPassword) bindPasswordEncrypted = undefined;
    if (input.bindPassword !== undefined) {
      if (!this.cipher.available) {
        throw new DomainError(
          "SECRET_CIPHER_UNAVAILABLE",
          "配置 LDAP bind 密码前必须提供 AutoForge 主密钥。",
        );
      }
      bindPasswordEncrypted = this.cipher.encrypt(input.bindPassword, "ldap:default:bind-password");
    }
    if (input.bindDn && !bindPasswordEncrypted) {
      throw new DomainError("LDAP_BIND_PASSWORD_REQUIRED", "填写 Bind DN 时必须提供 bind 密码。");
    }
    const saved = await this.repository.saveLdapConfiguration({
      enabled: input.enabled,
      url: input.url,
      tlsRejectUnauthorized: input.tlsRejectUnauthorized,
      connectTimeoutMs: input.connectTimeoutMs,
      bindDn: input.bindDn,
      ...(bindPasswordEncrypted ? { bindPasswordEncrypted } : {}),
      userBaseDn: input.userBaseDn,
      userFilter: input.userFilter,
      displayNameAttribute: input.displayNameAttribute,
      mailAttribute: input.mailAttribute,
      groupAttribute: input.groupAttribute,
      groupSearchBase: input.groupSearchBase,
      groupSearchFilter: input.groupSearchFilter,
      groupNameAttribute: input.groupNameAttribute,
      defaultRole: input.defaultRole,
      updatedAt: this.now(),
      updatedBy: actor.user.username,
    });
    await this.audit({
      actorId: actor.user.id,
      action: "ldap.configure",
      resourceType: "ldap_configuration",
      resourceId: "default",
      result: "succeeded",
      requestId,
      details: {
        enabled: saved.enabled,
        protocol: ldapProtocol(saved.url),
        tlsRejectUnauthorized: saved.tlsRejectUnauthorized,
      },
    });
    return publicLdapConfiguration(saved);
  }

  async testLdapConfiguration(
    actor: AuthenticatedIdentity,
    input: LdapConfigurationInput,
    requestId?: string,
  ): Promise<void> {
    this.authorize(actor, "ldap.manage");
    const existing = await this.repository.getLdapConfiguration();
    const bindPassword =
      input.bindPassword ??
      (input.bindDn && !input.clearBindPassword ? this.decryptStoredBindPassword(existing) : "");
    if (input.bindDn && !bindPassword) {
      throw new DomainError("LDAP_BIND_PASSWORD_REQUIRED", "填写 Bind DN 时必须提供 bind 密码。");
    }
    await this.directory.test({
      enabled: input.enabled,
      url: input.url,
      tlsRejectUnauthorized: input.tlsRejectUnauthorized,
      connectTimeoutMs: input.connectTimeoutMs,
      bindDn: input.bindDn,
      bindPassword,
      userBaseDn: input.userBaseDn,
      userFilter: input.userFilter,
      displayNameAttribute: input.displayNameAttribute,
      mailAttribute: input.mailAttribute,
      groupAttribute: input.groupAttribute,
      groupSearchBase: input.groupSearchBase,
      groupSearchFilter: input.groupSearchFilter,
      groupNameAttribute: input.groupNameAttribute,
      defaultRole: input.defaultRole,
    });
    await this.audit({
      actorId: actor.user.id,
      action: "ldap.test",
      resourceType: "ldap_configuration",
      resourceId: "default",
      result: "succeeded",
      requestId,
      details: {
        protocol: ldapProtocol(input.url),
      },
    });
  }

  async listAudit(
    actor: AuthenticatedIdentity,
    input: {
      projectId?: string;
      actorId?: string;
      action?: string;
      resourceType?: string;
      result?: AuditEvent["result"];
      recordedAfter?: string;
      recordedBefore?: string;
      cursor?: string;
      limit: number;
    },
  ) {
    const projectIds = this.auditProjectScope(actor, "audit.read", input.projectId);
    return this.repository.listAudit({
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.resourceType ? { resourceType: input.resourceType } : {}),
      ...(input.result ? { result: input.result } : {}),
      ...(input.recordedAfter ? { recordedAfter: input.recordedAfter } : {}),
      ...(input.recordedBefore ? { recordedBefore: input.recordedBefore } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: input.limit,
      ...(projectIds ? { projectIds } : {}),
      ...(input.projectId && actor.systemPermissions.includes("audit.read")
        ? { includeUnscoped: true }
        : {}),
    });
  }

  async recordTerminalSession(
    actor: AuthenticatedIdentity,
    runnerId: string,
    sessionId: string,
    projectId: string,
    requestId?: string,
  ): Promise<void> {
    this.authorize(actor, "runner.terminal", projectId);
    await this.audit({
      actorId: actor.user.id,
      action: "terminal.session_create",
      resourceType: "runner",
      resourceId: runnerId,
      projectId,
      result: "succeeded",
      requestId,
      details: { sessionId },
    });
  }

  async recordTerminalLifecycle(input: {
    actorId: string;
    runnerId: string;
    sessionId: string;
    action: "terminal.session_started" | "terminal.session_finished";
    reason?: string;
    inputMessages?: number;
    inputBytes?: number;
    outputBytes?: number;
  }): Promise<void> {
    await this.repository.appendAudit({
      id: this.ids.next(),
      actorType: "user",
      actorId: input.actorId,
      action: input.action,
      resourceType: "runner",
      resourceId: input.runnerId,
      result: "succeeded",
      details: {
        sessionId: input.sessionId,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.inputMessages === undefined ? {} : { inputMessages: input.inputMessages }),
        ...(input.inputBytes === undefined ? {} : { inputBytes: input.inputBytes }),
        ...(input.outputBytes === undefined ? {} : { outputBytes: input.outputBytes }),
      },
      recordedAt: this.now(),
    });
  }

  async recordAuthorizedOperation(
    actor: AuthenticatedIdentity,
    input: {
      action: string;
      resourceType: string;
      resourceId?: string;
      projectId?: string;
      requestId?: string;
      details?: AuditEvent["details"];
    },
  ): Promise<void> {
    if (input.projectId) await this.readModelInvalidation?.invalidate(input.projectId);
    await this.audit({
      actorId: actor.user.id,
      action: input.action,
      resourceType: input.resourceType,
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      result: "succeeded",
      ...(input.requestId ? { requestId: input.requestId } : {}),
      details: input.details ?? {},
    });
  }

  async recordRunnerOperation(input: {
    runnerId: string;
    action: string;
    requestId?: string;
    details?: AuditEvent["details"];
  }): Promise<void> {
    await this.repository.appendAudit({
      id: this.ids.next(),
      actorType: "runner",
      actorId: input.runnerId,
      action: input.action,
      resourceType: "runner",
      resourceId: input.runnerId,
      result: "succeeded",
      ...(input.requestId ? { requestId: input.requestId } : {}),
      details: input.details ?? {},
      recordedAt: this.now(),
    });
  }

  async exportAudit(
    actor: AuthenticatedIdentity,
    input: {
      projectId?: string;
      actorId?: string;
      action?: string;
      resourceType?: string;
      result?: AuditEvent["result"];
      recordedAfter?: string;
      recordedBefore?: string;
      maximumEvents: number;
    },
  ): Promise<AuditEvent[]> {
    const projectIds = this.auditProjectScope(actor, "audit.export", input.projectId);
    const events: AuditEvent[] = [];
    let cursor: string | undefined;
    while (events.length < input.maximumEvents) {
      const page = await this.repository.listAudit({
        ...(projectIds ? { projectIds } : {}),
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.action ? { action: input.action } : {}),
        ...(input.resourceType ? { resourceType: input.resourceType } : {}),
        ...(input.result ? { result: input.result } : {}),
        ...(input.recordedAfter ? { recordedAfter: input.recordedAfter } : {}),
        ...(input.recordedBefore ? { recordedBefore: input.recordedBefore } : {}),
        ...(cursor ? { cursor } : {}),
        limit: Math.min(200, input.maximumEvents - events.length),
      });
      events.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return events;
  }

  private auditProjectScope(
    actor: AuthenticatedIdentity,
    permission: "audit.read" | "audit.export",
    requestedProjectId?: string,
  ): string[] | undefined {
    const authorizedProjectIds = this.projectScope(actor, permission);
    if (!requestedProjectId) return authorizedProjectIds;
    if (authorizedProjectIds && !authorizedProjectIds.includes(requestedProjectId)) {
      throw new DomainError("AUTH_FORBIDDEN", "当前账号不能访问指定项目的审计记录。");
    }
    return [requestedProjectId];
  }

  private async loginLocally(
    password: string,
    credential: StoredUserCredential | null,
    requestId?: string,
  ): Promise<SessionResult> {
    const passwordMatches = await this.passwords.verify(
      password,
      credential?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    const now = this.clock.now();
    const accepted =
      credential !== null &&
      credential.user.source === "local" &&
      credential.user.status === "active" &&
      !isLocked(credential.user.lockedUntil, now) &&
      passwordMatches;
    if (!accepted) {
      if (credential?.user.source === "local" && credential.user.status === "active") {
        const failures = credential.user.failedLoginAttempts + 1;
        const lockedUntil =
          failures >= MAXIMUM_FAILED_LOGINS
            ? new Date(now.getTime() + LOGIN_LOCK_MINUTES * 60_000).toISOString()
            : undefined;
        await this.repository.recordLoginFailure(
          credential.user.id,
          failures,
          lockedUntil,
          now.toISOString(),
        );
      }
      return this.rejectedLogin("local", credential?.user.id, requestId);
    }
    if (!credential) throw new Error("Accepted local login did not resolve a user.");
    const session = await this.createSession(credential.user.id);
    await this.successfulLogin("local", credential.user.id, requestId);
    return session;
  }

  private async loginWithLdap(
    username: string,
    password: string,
    configuration: StoredLdapConfiguration | null,
    requestId?: string,
  ): Promise<SessionResult> {
    if (!configuration?.enabled) return this.rejectedLogin("ldap", undefined, requestId);
    let directoryIdentity: DirectoryIdentity;
    try {
      directoryIdentity = await this.directory.authenticate(
        this.directoryConfiguration(configuration),
        username,
        password,
      );
    } catch (error) {
      if (error instanceof DomainError && error.code !== "LDAP_CREDENTIAL_REJECTED") {
        await this.audit({
          action: "auth.login",
          resourceType: "session",
          result: "failed",
          requestId,
          details: { provider: "ldap", reasonCode: error.code },
        });
        throw error;
      }
      return this.rejectedLogin("ldap", undefined, requestId, error);
    }
    try {
      const synchronizedAt = this.now();
      const token = this.tokens.issue();
      const expiresAt = new Date(
        new Date(synchronizedAt).getTime() + this.sessionTtlHours * 60 * 60 * 1_000,
      ).toISOString();
      const user = await this.repository.completeLdapLogin({
        ldapUser: {
          userId: this.ids.next(),
          externalIdentityId: this.ids.next(),
          providerId: LDAP_PROVIDER_ID,
          identity: directoryIdentity,
          synchronizedAt,
        },
        defaultRole: this.ldapDefaultRole(configuration.defaultRole, synchronizedAt),
        session: {
          id: this.ids.next(),
          tokenHash: this.tokens.hash(token),
          createdAt: synchronizedAt,
          expiresAt,
        },
        audit: {
          id: this.ids.next(),
          actorType: "user",
          action: "auth.login",
          resourceType: "session",
          result: "succeeded",
          ...(requestId ? { requestId } : {}),
          details: { provider: "ldap" },
          recordedAt: synchronizedAt,
        },
      });
      return { token, expiresAt, userId: user.id };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "LDAP_LOGIN_FINALIZATION_FAILED",
        "LDAP 身份验证已通过，但平台账号关联或会话创建失败。请联系管理员并提供请求 ID。",
        { cause: error },
      );
    }
  }

  private async createSession(userId: string): Promise<SessionResult> {
    const token = this.tokens.issue();
    const createdAt = this.clock.now();
    const expiresAt = new Date(
      createdAt.getTime() + this.sessionTtlHours * 60 * 60 * 1_000,
    ).toISOString();
    const sessionId = this.ids.next();
    const user = await this.repository.createSessionAfterLogin({
      id: sessionId,
      userId,
      tokenHash: this.tokens.hash(token),
      createdAt: createdAt.toISOString(),
      expiresAt,
    });
    return { token, expiresAt, userId: user.id };
  }

  private async rejectedLogin(
    provider: "local" | "ldap",
    userId: string | undefined,
    requestId?: string,
    cause?: unknown,
  ): Promise<never> {
    await this.audit({
      actorId: userId,
      action: "auth.login",
      resourceType: "session",
      result: "rejected",
      requestId,
      details: { provider },
    });
    throw new DomainError("AUTHENTICATION_FAILED", "用户名或密码无效。", { cause });
  }

  private async successfulLogin(
    provider: "local" | "ldap",
    userId: string,
    requestId?: string,
  ): Promise<void> {
    await this.audit({
      actorId: userId,
      action: "auth.login",
      resourceType: "session",
      result: "succeeded",
      requestId,
      details: { provider },
    });
  }

  private directoryConfiguration(stored: StoredLdapConfiguration): DirectoryConfiguration {
    return {
      enabled: stored.enabled,
      url: stored.url,
      tlsRejectUnauthorized: stored.tlsRejectUnauthorized,
      connectTimeoutMs: stored.connectTimeoutMs,
      bindDn: stored.bindDn,
      bindPassword: this.decryptStoredBindPassword(stored),
      userBaseDn: stored.userBaseDn,
      userFilter: stored.userFilter,
      displayNameAttribute: stored.displayNameAttribute,
      mailAttribute: stored.mailAttribute,
      groupAttribute: stored.groupAttribute,
      groupSearchBase: stored.groupSearchBase,
      groupSearchFilter: stored.groupSearchFilter,
      groupNameAttribute: stored.groupNameAttribute,
      defaultRole: stored.defaultRole,
    };
  }

  private decryptStoredBindPassword(stored: StoredLdapConfiguration | null): string {
    if (stored && !stored.bindDn) return "";
    if (!stored?.bindPasswordEncrypted || !this.cipher.available) {
      throw new DomainError(
        "LDAP_BIND_PASSWORD_UNAVAILABLE",
        "LDAP bind 密码不可用，请检查主密钥或重新保存配置。",
      );
    }
    return this.cipher.decrypt(stored.bindPasswordEncrypted, "ldap:default:bind-password");
  }

  private async requiredUser(userId: string) {
    const user = await this.repository.findUser(userId);
    if (!user) throw new DomainError("USER_NOT_FOUND", "指定用户不存在。");
    return user;
  }

  private ldapDefaultRole(
    defaultRole: StoredLdapConfiguration["defaultRole"],
    recordedAt: string,
  ): { roleId: string; projectId?: string; recordedAt: string } {
    if (defaultRole === "admin") {
      return { roleId: SYSTEM_ADMIN_ROLE_ID, recordedAt };
    }
    return {
      roleId: defaultRole === "editor" ? TEST_MANAGER_ROLE_ID : VIEWER_ROLE_ID,
      projectId: DEFAULT_PROJECT_ID,
      recordedAt,
    };
  }

  private async requiredRole(roleId: string) {
    const role = await this.repository.findRole(roleId);
    if (!role) throw new DomainError("ROLE_NOT_FOUND", "指定角色不存在。");
    return role;
  }

  private async ensureSystemAdministratorsRemain(exclusion: {
    userId?: string;
    roleId?: string;
  }): Promise<void> {
    const bindings = await this.repository.listSystemRoleBindingsForActiveUsers();
    if (countSystemAdministrators(bindings, exclusion) === 0) {
      throw new DomainError(
        "LAST_ADMIN_REQUIRED",
        "该操作会使系统失去最后一位可管理用户与角色的管理员。",
      );
    }
  }

  private async ensureProjectOwnerCanStillManage(
    userId: string,
    projectId: string,
    removedRoleId: string,
  ): Promise<void> {
    const project = (await this.repository.listProjects([projectId]))[0];
    if (!project || project.ownerUserId !== userId) return;
    if (await this.userCanManageProject(userId, projectId, removedRoleId)) return;
    throw new DomainError(
      "PROJECT_OWNER_ROLE_REQUIRED",
      "必须先转移项目负责人，不能移除当前负责人最后一个项目管理角色。",
    );
  }

  private async userCanManageProject(
    userId: string,
    projectId: string,
    excludedProjectRoleId?: string,
  ): Promise<boolean> {
    const [roles, systemBindings, memberships] = await Promise.all([
      this.repository.listRoles(),
      this.repository.listSystemRoleBindings(),
      this.repository.listProjectMemberships(projectId),
    ]);
    const managingRoleIds = new Set(
      roles
        .filter((role) => role.active && role.permissions.includes("project.manage"))
        .map((role) => role.id),
    );
    if (
      systemBindings.some(
        (binding) => binding.userId === userId && managingRoleIds.has(binding.roleId),
      )
    ) {
      return true;
    }
    const membership = memberships.find((entry) => entry.user.id === userId);
    return Boolean(
      membership?.roleIds.some(
        (roleId) => roleId !== excludedProjectRoleId && managingRoleIds.has(roleId),
      ),
    );
  }

  private async audit(input: AuditInput): Promise<void> {
    await this.repository.appendAudit({
      id: this.ids.next(),
      actorType: input.actorId ? "user" : "system",
      ...(input.actorId ? { actorId: input.actorId } : {}),
      action: input.action,
      resourceType: input.resourceType,
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      result: input.result,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      details: input.details,
      recordedAt: this.now(),
    });
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

function normalizeUsername(username: string): string {
  return username.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function isLocked(lockedUntil: string | undefined, now: Date): boolean {
  return Boolean(lockedUntil && new Date(lockedUntil).getTime() > now.getTime());
}

function validatedPermissions(values: string[]): Permission[] {
  const unique = [...new Set(values)];
  if (unique.some((value) => !isPermission(value))) {
    throw new DomainError("PERMISSION_INVALID", "角色包含未知权限。");
  }
  return unique.sort() as Permission[];
}

function ldapProtocol(url: string): "ldaps" | "plain" {
  return url.toLocaleLowerCase("en-US").startsWith("ldaps://") ? "ldaps" : "plain";
}

function publicLdapConfiguration(configuration: StoredLdapConfiguration) {
  return {
    enabled: configuration.enabled,
    url: configuration.url,
    bindDn: configuration.bindDn,
    hasBindPassword: Boolean(configuration.bindPasswordEncrypted),
    userBaseDn: configuration.userBaseDn,
    userFilter: configuration.userFilter,
    displayNameAttribute: configuration.displayNameAttribute,
    mailAttribute: configuration.mailAttribute,
    groupAttribute: configuration.groupAttribute,
    groupSearchBase: configuration.groupSearchBase,
    groupSearchFilter: configuration.groupSearchFilter,
    groupNameAttribute: configuration.groupNameAttribute,
    defaultRole: configuration.defaultRole,
    tlsRejectUnauthorized: configuration.tlsRejectUnauthorized,
    connectTimeoutMs: configuration.connectTimeoutMs,
    updatedAt: configuration.updatedAt,
    updatedBy: configuration.updatedBy,
  };
}

function defaultPublicLdapConfiguration() {
  return {
    enabled: false,
    url: "",
    bindDn: "",
    hasBindPassword: false,
    userBaseDn: "",
    userFilter: "(uid={{username}})",
    displayNameAttribute: "displayName",
    mailAttribute: "mail",
    groupAttribute: "memberOf",
    groupSearchBase: "",
    groupSearchFilter: "(member={{userDn}})",
    groupNameAttribute: "cn",
    defaultRole: "editor" as const,
    tlsRejectUnauthorized: true,
    connectTimeoutMs: 5_000,
    updatedAt: null,
    updatedBy: "",
  };
}
