import {
  isPermission,
  type AuditEvent,
  type Permission,
  type Project,
  type Role,
  type User,
} from "@autoforge/domain";

export type UserRow = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  source: "local" | "ldap";
  status: "active" | "disabled";
  forcePasswordChange: boolean;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type RoleRow = {
  id: string;
  key: string;
  name: string;
  description: string;
  scope: "system" | "project";
  builtIn: boolean;
  active: boolean;
  permissionsJson: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectRow = {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  archived: boolean;
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuditRow = {
  id: string;
  actorType: "user" | "runner" | "system";
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  result: "succeeded" | "rejected" | "failed";
  requestId: string | null;
  detailsJson: string;
  recordedAt: string;
};

export function mapUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    ...(row.email ? { email: row.email } : {}),
    source: row.source,
    status: row.status,
    forcePasswordChange: row.forcePasswordChange,
    failedLoginAttempts: row.failedLoginAttempts,
    ...(row.lockedUntil ? { lockedUntil: row.lockedUntil } : {}),
    ...(row.lastLoginAt ? { lastLoginAt: row.lastLoginAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function mapRole(row: RoleRow): Role {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    scope: row.scope,
    builtIn: row.builtIn,
    active: row.active,
    permissions: parsePermissions(row.permissionsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapProject(row: ProjectRow): Project {
  const { ownerUserId, ...project } = row;
  return { ...project, ...(ownerUserId ? { ownerUserId } : {}) };
}

export function mapAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    actorType: row.actorType,
    ...(row.actorId ? { actorId: row.actorId } : {}),
    action: row.action,
    resourceType: row.resourceType,
    ...(row.resourceId ? { resourceId: row.resourceId } : {}),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    result: row.result,
    ...(row.requestId ? { requestId: row.requestId } : {}),
    details: parseAuditDetails(row.detailsJson),
    recordedAt: row.recordedAt,
  };
}

export function parsePermissions(json: string): Permission[] {
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

function parseAuditDetails(json: string): AuditEvent["details"] {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string | number | boolean | null] =>
        ["string", "number", "boolean"].includes(typeof entry[1]) || entry[1] === null,
    ),
  );
}
