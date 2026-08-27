import type {
  BootstrapAdminInput,
  CreateProjectInput,
  CreateRoleInput,
  CreateUserInput,
  LdapConfigurationInput,
  LdapGroupMappingInput,
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
} from "./ports";

import { SessionIdentityCache } from "./session-identity-cache";

const SYSTEM_ADMIN_ROLE_ID = "00000000-0000-7000-8100-000000000001";
const PROJECT_ADMIN_ROLE_ID = "00000000-0000-7000-8100-000000000002";
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
  ) {}

  /**
   * 会话身份缓存：鉴权读取是所有认证请求的固定成本，短 TTL 让热点会话跳过
   * 数据库往返。所有会撤销会话或改变权限的操作必须调用
   * invalidateCachedSessionIdentities()；跨进程部署下缓存失效以 TTL 为上限。
   */
  private readonly sessionIdentities = new SessionIdentityCache(1_500);

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
    return input.provider === "ldap"
      ? this.loginWithLdap(input.username, input.password, requestId)
      : this.loginLocally(input.username, input.password, requestId);
  }

  async authenticateSession(token: string): Promise<AuthenticatedIdentity> {
    if (!token) throw new DomainError("AUTH_REQUIRED", "请先登录。");
    const tokenHash = this.tokens.hash(token);
    const nowMs = this.clock.now().getTime();
    const cached = this.sessionIdentities.get(tokenHash, nowMs);
    if (cached) return cached;
    const identity = await this.repository.resolveSession(tokenHash, this.now());
    if (!identity || identity.user.status !== "active") {
      throw new DomainError("AUTH_REQUIRED", "登录会话无效或已过期。");
    }
    this.sessionIdentities.set(tokenHash, identity, nowMs);
    return identity;
  }

  /** 撤销类/权限类变更的统一失效钩子；见 sessionIdentities 字段注释。 */
  private invalidateCachedSessionIdentities(): void {
    this.sessionIdentities.clear();
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
    this.invalidateCachedSessionIdentities();
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
    this.invalidateCachedSessionIdentities();
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
    this.invalidateCachedSessionIdentities();
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
    this.invalidateCachedSessionIdentities();
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
    this.invalidateCachedSessionIdentities();
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
    this.invalidateCachedSessionIdentities();
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

  async listSystemRoleBindings(actor: AuthenticatedIdentity) {
    this.authorize(actor, "role.read");
    return this.repository.listSystemRoleBindings();
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
    this.invalidateCachedSessionIdentities();
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
    this.invalidateCachedSessionIdentities();
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
    this.invalidateCachedSessionIdentities();
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
    this.invalidateCachedSessionIdentities();
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
    this.invalidateCachedSessionIdentities();
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
    this.invalidateCachedSessionIdentities();
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
      this.invalidateCachedSessionIdentities();
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
    return configuration ? publicLdapConfiguration(configuration) : null;
  }

  async saveLdapConfiguration(
    actor: AuthenticatedIdentity,
    input: LdapConfigurationInput,
    requestId?: string,
  ) {
    this.authorize(actor, "ldap.manage");
    const existing = await this.repository.getLdapConfiguration();
    let bindPasswordEncrypted = existing?.bindPasswordEncrypted;
    if (input.bindPassword !== undefined) {
      if (!this.cipher.available) {
        throw new DomainError(
          "SECRET_CIPHER_UNAVAILABLE",
          "配置 LDAP bind 密码前必须提供 AutoForge 主密钥。",
        );
      }
      bindPasswordEncrypted = this.cipher.encrypt(input.bindPassword, "ldap:default:bind-password");
    }
    if (!bindPasswordEncrypted) {
      throw new DomainError("LDAP_BIND_PASSWORD_REQUIRED", "首次配置 LDAP 时必须提供 bind 密码。");
    }
    const saved = await this.repository.saveLdapConfiguration({
      enabled: input.enabled,
      urls: input.urls,
      tlsMode: input.tlsMode,
      ...(input.caPem ? { caPem: input.caPem } : {}),
      connectTimeoutMs: input.connectTimeoutMs,
      operationTimeoutMs: input.operationTimeoutMs,
      pageSize: input.pageSize,
      maximumUsers: input.maximumUsers,
      synchronizationIntervalMinutes: input.synchronizationIntervalMinutes,
      bindDn: input.bindDn,
      bindPasswordEncrypted,
      userBaseDn: input.userBaseDn,
      userFilter: input.userFilter,
      userIdAttribute: input.userIdAttribute,
      usernameAttribute: input.usernameAttribute,
      displayNameAttribute: input.displayNameAttribute,
      emailAttribute: input.emailAttribute,
      ...(input.groupBaseDn ? { groupBaseDn: input.groupBaseDn } : {}),
      ...(input.groupFilter ? { groupFilter: input.groupFilter } : {}),
      groupMemberAttribute: input.groupMemberAttribute,
      updatedAt: this.now(),
    });
    await this.audit({
      actorId: actor.user.id,
      action: "ldap.configure",
      resourceType: "ldap_configuration",
      resourceId: "default",
      result: "succeeded",
      requestId,
      details: { enabled: saved.enabled, tlsMode: saved.tlsMode, serverCount: saved.urls.length },
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
    const bindPassword = input.bindPassword ?? this.decryptStoredBindPassword(existing);
    await this.directory.test({
      enabled: input.enabled,
      urls: input.urls,
      tlsMode: input.tlsMode,
      ...(input.caPem ? { caPem: input.caPem } : {}),
      connectTimeoutMs: input.connectTimeoutMs,
      operationTimeoutMs: input.operationTimeoutMs,
      pageSize: input.pageSize,
      maximumUsers: input.maximumUsers,
      synchronizationIntervalMinutes: input.synchronizationIntervalMinutes,
      bindDn: input.bindDn,
      bindPassword,
      userBaseDn: input.userBaseDn,
      userFilter: input.userFilter,
      userIdAttribute: input.userIdAttribute,
      usernameAttribute: input.usernameAttribute,
      displayNameAttribute: input.displayNameAttribute,
      emailAttribute: input.emailAttribute,
      ...(input.groupBaseDn ? { groupBaseDn: input.groupBaseDn } : {}),
      ...(input.groupFilter ? { groupFilter: input.groupFilter } : {}),
      groupMemberAttribute: input.groupMemberAttribute,
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
      version: existing?.version ?? 1,
    });
    await this.audit({
      actorId: actor.user.id,
      action: "ldap.test",
      resourceType: "ldap_configuration",
      resourceId: "default",
      result: "succeeded",
      requestId,
      details: { serverCount: input.urls.length },
    });
  }

  async addLdapGroupMapping(
    actor: AuthenticatedIdentity,
    input: LdapGroupMappingInput,
    requestId?: string,
  ): Promise<void> {
    this.authorize(actor, "ldap.manage");
    const role = await this.requiredRole(input.roleId);
    if ((role.scope === "project") !== Boolean(input.projectId)) {
      throw new DomainError("ROLE_SCOPE_INVALID", "LDAP 组映射的角色和项目作用域不匹配。");
    }
    const recordedAt = this.now();
    await this.repository.addLdapGroupMapping({
      id: this.ids.next(),
      groupDn: input.groupDn,
      normalizedGroupDn: normalizeDn(input.groupDn),
      roleId: input.roleId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      priority: input.priority,
      recordedAt,
    });
    await this.audit({
      actorId: actor.user.id,
      action: "ldap.group_mapping_create",
      resourceType: "role",
      resourceId: input.roleId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      result: "succeeded",
      requestId,
      details: { groupDn: input.groupDn, priority: input.priority },
    });
  }

  async listLdapGroupMappings(actor: AuthenticatedIdentity) {
    this.authorize(actor, "ldap.read");
    return this.repository.listLdapGroupMappings();
  }

  async synchronizeLdap(actor: AuthenticatedIdentity, requestId?: string) {
    this.authorize(actor, "ldap.manage");
    return this.performLdapSynchronization(actor.user.id, requestId);
  }

  async synchronizeLdapAsSystem() {
    return this.performLdapSynchronization();
  }

  private async performLdapSynchronization(actorId?: string, requestId?: string) {
    const configuration = await this.repository.getLdapConfiguration();
    if (!configuration?.enabled) {
      throw new DomainError("LDAP_DISABLED", "LDAP 未启用，不能执行同步。");
    }
    const identities = await this.directory.listUsers(this.directoryConfiguration(configuration));
    const mappings = await this.repository.listLdapGroupMappings();
    const synchronizedAt = this.now();
    let createdOrUpdated = 0;
    for (const identity of identities) {
      const existing = await this.repository.findExternalIdentity(
        LDAP_PROVIDER_ID,
        identity.subject,
      );
      const user = await this.repository.upsertLdapUser({
        userId: existing?.userId ?? this.ids.next(),
        externalIdentityId: existing?.id ?? this.ids.next(),
        providerId: LDAP_PROVIDER_ID,
        identity,
        synchronizedAt,
      });
      await this.repository.replaceLdapRoleBindings({
        userId: user.id,
        groupDns: identity.groupDns.map(normalizeDn),
        mappings,
        recordedAt: synchronizedAt,
      });
      createdOrUpdated += 1;
    }
    const disabledUserIds = await this.repository.disableMissingLdapUsers({
      providerId: LDAP_PROVIDER_ID,
      activeSubjects: identities.map((identity) => identity.subject),
      recordedAt: synchronizedAt,
    });
    await this.audit({
      ...(actorId ? { actorId } : {}),
      action: "ldap.synchronize",
      resourceType: "ldap_configuration",
      resourceId: "default",
      result: "succeeded",
      requestId,
      details: { createdOrUpdated, disabled: disabledUserIds.length },
    });
    this.invalidateCachedSessionIdentities();
    return { synchronizedAt, createdOrUpdated, disabledUserIds };
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
    username: string,
    password: string,
    requestId?: string,
  ): Promise<SessionResult> {
    const credential = await this.repository.findUserByUsername(normalizeUsername(username));
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
    requestId?: string,
  ): Promise<SessionResult> {
    const configuration = await this.repository.getLdapConfiguration();
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
    const existing = await this.repository.findExternalIdentity(
      LDAP_PROVIDER_ID,
      directoryIdentity.subject,
    );
    const synchronizedAt = this.now();
    const user = await this.repository.upsertLdapUser({
      userId: existing?.userId ?? this.ids.next(),
      externalIdentityId: existing?.id ?? this.ids.next(),
      providerId: LDAP_PROVIDER_ID,
      identity: directoryIdentity,
      synchronizedAt,
    });
    if (user.status !== "active") return this.rejectedLogin("ldap", user.id, requestId);
    const mappings = await this.repository.listLdapGroupMappings();
    await this.repository.replaceLdapRoleBindings({
      userId: user.id,
      groupDns: directoryIdentity.groupDns.map(normalizeDn),
      mappings,
      recordedAt: synchronizedAt,
    });
    const session = await this.createSession(user.id);
    await this.successfulLogin("ldap", user.id, requestId);
    return session;
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
    return { ...stored, bindPassword: this.decryptStoredBindPassword(stored) };
  }

  private decryptStoredBindPassword(stored: StoredLdapConfiguration | null): string {
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

function normalizeDn(distinguishedName: string): string {
  return distinguishedName.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
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

function publicLdapConfiguration(configuration: StoredLdapConfiguration) {
  const { bindPasswordEncrypted: _secret, ...publicConfiguration } = configuration;
  return { ...publicConfiguration, bindPasswordConfigured: Boolean(_secret) };
}
