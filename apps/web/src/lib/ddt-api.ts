import "server-only";

import type { AuthenticatedIdentity, DdtScope, Permission } from "@autoforge/domain";
import { DomainError } from "@autoforge/domain";

import { authorizedProjectScope } from "./auth";
import { getPlatformServices, type PlatformServices } from "./services";

export function ddtScopeFromUrl(url: URL): DdtScope {
  const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  const projectVersionId = url.searchParams.get("projectVersionId")?.trim() ?? "";
  const testStageId = url.searchParams.get("testStageId")?.trim() ?? "";
  if (!projectId || !projectVersionId || !testStageId) {
    throw new DomainError("DDT_SCOPE_REQUIRED", "DDT 操作必须指定项目、项目版本和测试阶段。");
  }
  return { projectId, projectVersionId, testStageId };
}

export async function authorizeDdtScope(
  identity: AuthenticatedIdentity,
  permission: Permission,
  url: URL,
): Promise<{ scope: DdtScope; services: PlatformServices }> {
  const scope = ddtScopeFromUrl(url);
  authorizedProjectScope(identity, permission, scope.projectId);
  const services = await getPlatformServices();
  const structure = await services.projectStructures.list(scope.projectId);
  const version = structure.versions.find((item) => item.id === scope.projectVersionId);
  if (!version || !version.stages.some((stage) => stage.id === scope.testStageId)) {
    throw new DomainError(
      "DDT_SCOPE_NOT_FOUND",
      "指定的项目版本或测试阶段不存在，或不属于当前项目。",
    );
  }
  return { scope, services };
}

export function ddtScopeQuery(scope: DdtScope): string {
  return new URLSearchParams(scope).toString();
}
