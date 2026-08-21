import "server-only";

import type { AuthenticatedIdentity, Permission, Project } from "@autoforge/domain";
import { projectIdsForPermission } from "@autoforge/domain";
import { cookies } from "next/headers";

export const SELECTED_PROJECT_COOKIE_NAME = "autoforge_project";

const SYSTEM_PROJECT_CONTEXT_PERMISSIONS: readonly Permission[] = [
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
  "log.read",
  "artifact.read",
  "project.read",
  "project.manage",
  "audit.read",
  "audit.export",
];

export function selectableProjectIds(identity: AuthenticatedIdentity): string[] | undefined {
  if (
    SYSTEM_PROJECT_CONTEXT_PERMISSIONS.some((permission) =>
      identity.systemPermissions.includes(permission),
    )
  ) {
    return undefined;
  }
  return Object.keys(identity.projectPermissions);
}

export async function selectedProjectId(
  identity: AuthenticatedIdentity,
  projects: readonly Project[],
  permission?: Permission,
): Promise<string | undefined> {
  const permittedProjectIds = permission
    ? projectIdsForPermission(identity, permission)
    : undefined;
  const accessibleProjects = permittedProjectIds
    ? projects.filter((project) => permittedProjectIds.includes(project.id))
    : projects;
  const requestedProjectId = (await cookies()).get(SELECTED_PROJECT_COOKIE_NAME)?.value;
  return projects.some((project) => project.id === requestedProjectId)
    ? requestedProjectId
    : accessibleProjects[0]?.id;
}
