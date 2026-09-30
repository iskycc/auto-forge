import type { ReadModelQuery } from "@autoforge/contracts";
import {
  AuthorizationDeniedError,
  hasPermission,
  type AuthenticatedIdentity,
  type Permission,
} from "@autoforge/domain";

/** Cache namespaces are not necessarily project scopes; authorize the query's actual sources. */
export function authorizeReadModelQuery(
  identity: AuthenticatedIdentity,
  query: ReadModelQuery,
): void {
  const require = (permission: Permission, projectId?: string) => {
    if (!hasPermission(identity, permission, projectId))
      throw new AuthorizationDeniedError(identity, permission, projectId);
  };
  if (query.kind === "public_statistics") return;
  if (query.kind === "analytics_scope") {
    if (query.filter.projectId) require("run.read", query.filter.projectId);
    else if (query.projectIds)
      for (const projectId of query.projectIds) require("run.read", projectId);
    else require("run.read");
    return;
  }
  if (query.kind === "batch_counters") {
    for (const projectId of new Set(query.batches.map((batch) => batch.projectId)))
      require("run.read", projectId);
    return;
  }
  const permission = readModelPermission(identity, query);
  require(permission, query.projectId);
  if (query.kind === "case_directory" && query.filter?.missingSuiteId)
    require("case_suite.read", query.projectId);
  if (query.kind === "batch_comparison") require("run.read", query.rightProjectId);
}

function readModelPermission(identity: AuthenticatedIdentity, query: ReadModelQuery): Permission {
  switch (query.kind) {
    case "dashboard":
      return hasPermission(identity, "case.read", query.projectId) ? "case.read" : "run.read";
    case "case_directory":
    case "ddt_dashboard":
      return "case.read";
    case "source_preview":
    case "source_directory":
      return "case_source.read";
    case "suite_directory":
      return "case_suite.read";
    case "analysis_statistics":
      return "audit.read";
    case "analysis_batch":
      return hasPermission(identity, "audit.read", query.projectId) ? "audit.read" : "run.read";
    default:
      return "run.read";
  }
}
