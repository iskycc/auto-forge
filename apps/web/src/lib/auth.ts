import "server-only";

import { randomUUID } from "node:crypto";

import type { AuthenticatedIdentity, Permission } from "@autoforge/domain";
import { DEFAULT_PROJECT_ID, DomainError, isPermission } from "@autoforge/domain";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getPlatformServices } from "./services";

export const SESSION_COOKIE_NAME = "autoforge_session";

export async function authenticateRequest(request: Request): Promise<AuthenticatedIdentity> {
  const services = await getPlatformServices();
  const sessionToken = requestCookie(request, SESSION_COOKIE_NAME);
  if (sessionToken) return services.identityAccess.authenticateSession(sessionToken);
  const apiToken = request.headers.get("authorization")?.startsWith("Bearer af_api_")
    ? request.headers.get("authorization")?.slice(7).trim()
    : undefined;
  if (!apiToken) throw new DomainError("AUTH_REQUIRED", "需要登录或提供 API 令牌。");
  const authenticated = await services.platformOperations.authenticateApiToken(apiToken);
  if (!authenticated || authenticated.effectiveScopes.length === 0) {
    throw new DomainError("AUTHENTICATION_FAILED", "API 令牌无效、已过期或已撤销。");
  }
  const effective = new Set(authenticated.effectiveScopes);
  return {
    user: {
      id: authenticated.serviceAccount.id,
      username: `service-${authenticated.serviceAccount.id}`,
      displayName: authenticated.serviceAccount.name,
      source: "local",
      status: "active",
      forcePasswordChange: false,
      failedLoginAttempts: 0,
      createdAt: authenticated.serviceAccount.createdAt,
      updatedAt: authenticated.serviceAccount.updatedAt,
      version: authenticated.serviceAccount.revision,
    },
    sessionId: `api-token:${authenticated.token.id}`,
    systemPermissions: authenticated.serviceAccount.systemPermissions
      .filter(isPermission)
      .filter((permission) => effective.has(permission)),
    projectPermissions: Object.fromEntries(
      Object.entries(authenticated.serviceAccount.projectPermissions).map(
        ([projectId, permissions]) => [
          projectId,
          permissions.filter(isPermission).filter((permission) => effective.has(permission)),
        ],
      ),
    ),
  };
}

export async function authorizeRequest(
  request: Request,
  permission: Permission,
  projectId: string | undefined = DEFAULT_PROJECT_ID,
): Promise<AuthenticatedIdentity> {
  const services = await getPlatformServices();
  const identity = await authenticateRequest(request);
  services.identityAccess.authorize(identity, permission, projectId);
  return identity;
}

export async function currentIdentity(): Promise<AuthenticatedIdentity | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? "";
  if (!token) return null;
  try {
    return await (await getPlatformServices()).identityAccess.authenticateSession(token);
  } catch {
    return null;
  }
}

export async function requirePagePermission(
  permission: Permission,
  projectId: string | undefined = DEFAULT_PROJECT_ID,
): Promise<AuthenticatedIdentity> {
  const services = await getPlatformServices();
  const identity = await currentIdentity();
  if (!identity) {
    redirect((await services.identityAccess.setupRequired()) ? "/setup" : "/login");
  }
  try {
    services.identityAccess.authorize(identity, permission, projectId);
    return identity;
  } catch {
    redirect("/forbidden");
  }
}

export async function requirePageProjectScope(permission: Permission): Promise<{
  identity: AuthenticatedIdentity;
  projectIds: string[] | undefined;
}> {
  const services = await getPlatformServices();
  const identity = await currentIdentity();
  if (!identity) {
    redirect((await services.identityAccess.setupRequired()) ? "/setup" : "/login");
  }
  try {
    return { identity, projectIds: services.identityAccess.projectScope(identity, permission) };
  } catch {
    redirect("/forbidden");
  }
}

export function requireSameOrigin(request: Request): void {
  if (request.headers.get("authorization")?.startsWith("Bearer af_api_")) return;
  const originValue = request.headers.get("origin");
  if (!originValue) {
    throw new DomainError("CSRF_REJECTED", "缺少请求来源信息。");
  }
  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch (error) {
    throw new DomainError("CSRF_REJECTED", "请求来源无效。", { cause: error });
  }
  const forwardedHost = firstHeader(request.headers.get("x-forwarded-host"));
  const expectedHost = forwardedHost ?? request.headers.get("host") ?? new URL(request.url).host;
  const forwardedProtocol = firstHeader(request.headers.get("x-forwarded-proto"));
  const expectedProtocol = `${forwardedProtocol ?? new URL(request.url).protocol.replace(":", "")}:`;
  if (origin.host !== expectedHost || origin.protocol !== expectedProtocol) {
    throw new DomainError("CSRF_REJECTED", "请求来源不受信任。");
  }
}

export function sessionCookie(token: string, expiresAt: string, request: Request) {
  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "strict" as const,
    secure: requestUsesHttps(request),
    path: "/",
    expires: new Date(expiresAt),
  };
}

export function expiredSessionCookie(request: Request) {
  return {
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "strict" as const,
    secure: requestUsesHttps(request),
    path: "/",
    maxAge: 0,
  };
}

export function requestId(request: Request): string {
  const value = request.headers.get("x-request-id")?.trim();
  return value && value.length <= 128 ? value : randomUUID();
}

export function clientAddress(request: Request): string {
  return firstHeader(request.headers.get("x-forwarded-for")) ?? "unknown";
}

function requestCookie(request: Request, name: string): string {
  const cookieHeader = request.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function firstHeader(value: string | null): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function requestUsesHttps(request: Request): boolean {
  if (new URL(request.url).protocol === "https:") return true;
  const forwardedProtocol = firstHeader(request.headers.get("x-forwarded-proto"))?.toLowerCase();
  return forwardedProtocol === "https";
}
