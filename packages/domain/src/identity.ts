export const permissionCatalog = [
  "case.read",
  "case.manage",
  "case_source.read",
  "case_source.manage",
  "case_suite.read",
  "case_suite.manage",
  "run.read",
  "run.create",
  "run.cancel",
  "run.retry",
  "analysis.manage",
  "analysis.assign",
  "log.read",
  "artifact.read",
  "runner.read",
  "runner.manage",
  "runner.terminal",
  "user.read",
  "user.manage",
  "role.read",
  "role.manage",
  "ldap.read",
  "ldap.manage",
  "project.read",
  "project.manage",
  "audit.read",
  "audit.export",
  "settings.read",
  "settings.manage",
  "api_token.manage",
] as const;

export type Permission = (typeof permissionCatalog)[number];
export type RoleScope = "system" | "project";
export type UserStatus = "active" | "disabled";
export type UserSource = "local" | "ldap";

export const DEFAULT_PROJECT_ID = "00000000-0000-7000-8000-000000000001";

export type User = {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  groups?: string[];
  source: UserSource;
  status: UserStatus;
  forcePasswordChange: boolean;
  failedLoginAttempts: number;
  lockedUntil?: string;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type UserSession = {
  id: string;
  userId: string;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
  revokedAt?: string;
};

export type Project = {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  archived: boolean;
  ownerUserId?: string;
  createdAt: string;
  updatedAt: string;
};

export type Role = {
  id: string;
  key: string;
  name: string;
  description: string;
  scope: RoleScope;
  builtIn: boolean;
  active: boolean;
  permissions: Permission[];
  createdAt: string;
  updatedAt: string;
};

export type ServiceAccount = {
  id: string;
  name: string;
  description: string;
  status: UserStatus;
  systemPermissions: Permission[];
  projectPermissions: Record<string, Permission[]>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type ApiToken = {
  id: string;
  serviceAccountId: string;
  name: string;
  tokenPrefix: string;
  scopes: Permission[];
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  replacedByTokenId?: string;
  createdAt: string;
};

export type ProjectMembership = {
  userId: string;
  projectId: string;
  roleIds: string[];
};

export type ExternalIdentity = {
  id: string;
  userId: string;
  providerId: string;
  subject: string;
  directoryUsername: string;
  attributes: Record<string, string>;
  synchronizedAt: string;
};

export type AuthenticatedIdentity = {
  user: User;
  sessionId: string;
  systemPermissions: Permission[];
  projectPermissions: Record<string, Permission[]>;
};

export type AuditResult = "succeeded" | "rejected" | "failed";

export type AuditEvent = {
  id: string;
  actorType: "user" | "runner" | "system";
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  projectId?: string;
  result: AuditResult;
  requestId?: string;
  details: Record<string, string | number | boolean | null>;
  recordedAt: string;
};

export type BuiltInRoleDefinition = Omit<Role, "createdAt" | "updatedAt">;

const projectAdministrationPermissions: Permission[] = [
  "case.read",
  "case.manage",
  "case_source.read",
  "case_source.manage",
  "case_suite.read",
  "case_suite.manage",
  "run.read",
  "run.create",
  "run.cancel",
  "run.retry",
  "analysis.manage",
  "analysis.assign",
  "log.read",
  "artifact.read",
  "runner.read",
  "runner.manage",
  "runner.terminal",
  "project.read",
  "project.manage",
  "audit.read",
];

export const builtInRoleDefinitions: BuiltInRoleDefinition[] = [
  {
    id: "00000000-0000-7000-8100-000000000001",
    key: "system-admin",
    name: "系统管理员",
    description: "管理平台、身份、权限、Runner 和所有项目。",
    scope: "system",
    builtIn: true,
    active: true,
    permissions: [...permissionCatalog],
  },
  {
    id: "00000000-0000-7000-8100-000000000002",
    key: "project-admin",
    name: "项目管理员",
    description: "管理指定项目的测试资产、执行、成员和 Runner 使用。",
    scope: "project",
    builtIn: true,
    active: true,
    permissions: projectAdministrationPermissions,
  },
  {
    id: "00000000-0000-7000-8100-000000000003",
    key: "test-manager",
    name: "测试管理员",
    description: "管理测试资产、环境和执行策略。",
    scope: "project",
    builtIn: true,
    active: true,
    permissions: [
      "case.read",
      "case.manage",
      "case_source.read",
      "case_source.manage",
      "case_suite.read",
      "case_suite.manage",
      "run.read",
      "run.create",
      "run.cancel",
      "run.retry",
      "analysis.manage",
      "log.read",
      "artifact.read",
      "runner.read",
    ],
  },
  {
    id: "00000000-0000-7000-8100-000000000004",
    key: "execution-operator",
    name: "执行操作员",
    description: "查看测试资产并创建、取消或重试执行。",
    scope: "project",
    builtIn: true,
    active: true,
    permissions: [
      "case.read",
      "case_source.read",
      "case_suite.read",
      "run.read",
      "run.create",
      "run.cancel",
      "run.retry",
      "analysis.manage",
      "log.read",
      "artifact.read",
      "runner.read",
    ],
  },
  {
    id: "00000000-0000-7000-8100-000000000005",
    key: "viewer",
    name: "只读观察者",
    description: "只读查看项目测试资产、执行结果和 Runner 状态。",
    scope: "project",
    builtIn: true,
    active: true,
    permissions: [
      "case.read",
      "case_source.read",
      "case_suite.read",
      "run.read",
      "log.read",
      "artifact.read",
      "runner.read",
    ],
  },
  {
    id: "00000000-0000-7000-8100-000000000006",
    key: "auditor",
    name: "审计员",
    description: "只读访问审计记录和相关执行证据。",
    scope: "system",
    builtIn: true,
    active: true,
    permissions: ["audit.read", "audit.export", "run.read", "log.read", "artifact.read"],
  },
];

export function hasPermission(
  identity: AuthenticatedIdentity,
  permission: Permission,
  projectId?: string,
): boolean {
  if (identity.systemPermissions.includes(permission)) return true;
  if (!projectId) return false;
  return identity.projectPermissions[projectId]?.includes(permission) ?? false;
}

export function projectIdsForPermission(
  identity: AuthenticatedIdentity,
  permission: Permission,
): string[] | undefined {
  if (identity.systemPermissions.includes(permission)) return undefined;
  return Object.entries(identity.projectPermissions)
    .filter(([, permissions]) => permissions.includes(permission))
    .map(([projectId]) => projectId)
    .sort();
}

export function isPermission(value: string): value is Permission {
  return (permissionCatalog as readonly string[]).includes(value);
}

/**
 * 恢复入口所需的最小管理权限集合：失去所有同时持有这两项权限的活跃用户后，
 * 平台将无法再管理用户与角色，因此停用角色或移除绑定时必须保留至少一人。
 */
export const administratorRecoveryPermissions: readonly Permission[] = [
  "user.manage",
  "role.manage",
];

export type SystemRoleBindingView = {
  userId: string;
  roleId: string;
  permissions: readonly Permission[];
};

/**
 * 统计仍可行使恢复权限的活跃用户数。仓储负责只返回活跃用户与启用角色的绑定；
 * exclusion 用于在“停用某角色”或“移除某用户绑定”生效前评估剩余人数。
 */
export function countSystemAdministrators(
  bindings: readonly SystemRoleBindingView[],
  exclusion?: { userId?: string; roleId?: string },
): number {
  const administrators = new Set<string>();
  for (const binding of bindings) {
    const excludedByRole =
      exclusion?.roleId === binding.roleId &&
      (exclusion.userId === undefined || exclusion.userId === binding.userId);
    const excludedByUser = exclusion?.roleId === undefined && exclusion?.userId === binding.userId;
    if (excludedByRole || excludedByUser) continue;
    if (
      administratorRecoveryPermissions.every((permission) =>
        binding.permissions.includes(permission),
      )
    ) {
      administrators.add(binding.userId);
    }
  }
  return administrators.size;
}
