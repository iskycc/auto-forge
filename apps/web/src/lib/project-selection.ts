import { DEFAULT_PROJECT_ID, type Project } from "@autoforge/domain";

export function fallbackProjectId(projects: readonly Project[]): string | undefined {
  return (
    projects.find((project) => project.id === DEFAULT_PROJECT_ID)?.id ??
    projects.find((project) => project.isDefault)?.id ??
    projects[0]?.id
  );
}
