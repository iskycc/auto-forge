import "server-only";
import { ddtSrTagScopeSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { authenticateRequest, authorizedProjectScope } from "./auth";
import { getPlatformServices } from "./services";
import { z } from "zod";
import {
  ddtSrTagQuerySchema,
  ddtSrTagLookupSchema,
  ddtSrTagGroupsSchema,
  ddtSrTagPageSchema,
} from "@autoforge/contracts";
import type { DdtSrTagService } from "@autoforge/application";
import type { DdtSrTagScope } from "@autoforge/contracts";

export async function readSrTagMetadata(service: DdtSrTagService, scope: DdtSrTagScope, url: URL) {
  if (url.searchParams.get("view") === "lookup") {
    const names = z.array(z.string().max(512)).max(40).parse(url.searchParams.getAll("srNum"));
    return ddtSrTagLookupSchema.parse(await service.lookup(scope, names));
  }
  const query = ddtSrTagQuerySchema.parse({
    ...Object.fromEntries(url.searchParams),
    ...(url.searchParams.has("tagId") ? { tagIds: url.searchParams.getAll("tagId") } : {}),
  });
  return url.searchParams.get("view") === "groups"
    ? ddtSrTagGroupsSchema.parse(await service.groups(scope, query))
    : ddtSrTagPageSchema.parse(await service.list(scope, query));
}

export async function authorizeSrTagScope(
  request: Request,
  url: URL,
  permission: import("@autoforge/domain").Permission,
) {
  const identity = await authenticateRequest(request);
  const scope = ddtSrTagScopeSchema.parse(Object.fromEntries(url.searchParams));
  authorizedProjectScope(identity, permission, scope.projectId);
  const services = await getPlatformServices();
  const structure = await services.projectStructures.list(scope.projectId);
  const version = structure.versions.find((entry) => entry.id === scope.projectVersionId);
  if (!version) throw new DomainError("DDT_SCOPE_NOT_FOUND", "项目版本不存在或不属于当前项目。");
  return { scope, services, identity, versionName: version.name };
}
