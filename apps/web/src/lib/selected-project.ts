import "server-only";

import type {
  AuthenticatedIdentity,
  Permission,
  Project,
  ProjectStructure,
} from "@autoforge/domain";
import { projectIdsForPermission, projectIdsForContext } from "@autoforge/domain";
import { cookies } from "next/headers";

import { fallbackProjectId } from "./project-selection";

export const SELECTED_PROJECT_COOKIE_NAME = "autoforge_project";
export const SELECTED_PROJECT_VERSION_COOKIE_NAME = "autoforge_project_version";
export const SELECTED_TEST_STAGE_COOKIE_NAME = "autoforge_test_stage";

export type SelectedProjectHierarchy = {
  projectVersionId?: string;
  testStageId?: string;
};

export function selectableProjectIds(identity: AuthenticatedIdentity): string[] | undefined {
  return projectIdsForContext(identity);
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
  // Keep the page and top bar on the same selected project. The page must show
  // its permission boundary instead of silently loading another project's data.
  return projects.some((project) => project.id === requestedProjectId)
    ? requestedProjectId
    : fallbackProjectId(accessibleProjects);
}

export async function selectedProjectHierarchy(
  structure: ProjectStructure | undefined,
): Promise<SelectedProjectHierarchy> {
  if (!structure) return {};
  const cookieStore = await cookies();
  const activeVersions = structure.versions.filter((version) => version.status === "active");
  const requestedVersionId = cookieStore.get(SELECTED_PROJECT_VERSION_COOKIE_NAME)?.value;
  const version =
    activeVersions.find((candidate) => candidate.id === requestedVersionId) ?? activeVersions[0];
  if (!version) return {};
  const activeStages = version.stages.filter((stage) => stage.status === "active");
  const requestedStageId = cookieStore.get(SELECTED_TEST_STAGE_COOKIE_NAME)?.value;
  const stage =
    activeStages.find((candidate) => candidate.id === requestedStageId) ?? activeStages[0];
  return {
    projectVersionId: version.id,
    ...(stage ? { testStageId: stage.id } : {}),
  };
}
