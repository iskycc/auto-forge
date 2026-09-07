import { DomainError, isDomainError } from "./errors";
import { isPermission, type AuthenticatedIdentity, type Permission } from "./identity";

export type AuthorizationDenial = {
  actorId: string;
  actorName: string;
  permission: Permission;
  projectId?: string;
};

export class AuthorizationDeniedError extends DomainError {
  readonly authorization: AuthorizationDenial;

  constructor(identity: AuthenticatedIdentity, permission: Permission, projectId?: string) {
    super("AUTH_FORBIDDEN", "当前账号没有执行此操作的权限。");
    // This context belongs to the audit boundary, not the public error details.
    this.authorization = {
      actorId: identity.user.id,
      actorName: `${identity.user.displayName} · ${identity.user.username}`,
      permission,
      ...(projectId ? { projectId } : {}),
    };
  }
}

export function isAuthorizationDeniedError(error: unknown): error is AuthorizationDeniedError {
  if (!isDomainError(error) || error.code !== "AUTH_FORBIDDEN" || !("authorization" in error))
    return false;
  const context = error.authorization;
  return (
    typeof context === "object" &&
    context !== null &&
    "actorId" in context &&
    typeof context.actorId === "string" &&
    "actorName" in context &&
    typeof context.actorName === "string" &&
    "permission" in context &&
    typeof context.permission === "string" &&
    isPermission(context.permission) &&
    (!("projectId" in context) || typeof context.projectId === "string")
  );
}
