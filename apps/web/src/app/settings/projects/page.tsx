import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { hasPermission } from "@autoforge/domain";
import { redirect } from "next/navigation";

import { ProjectActions } from "@/components/project-actions";
import { ProjectStructureManager } from "@/components/project-structure-manager";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { selectedProjectHierarchy, selectedProjectId } from "@/lib/selected-project";

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; cursor?: string; query?: string }>;
}) {
  const { identity } = await requirePageProjectScope("project.read");
  const parameters = await searchParams;
  // Preserve saved member links while removing the duplicated management entry.
  if (parameters.section === "members") {
    const query = new URLSearchParams({ section: "users", scope: "project" });
    if (parameters.query) query.set("query", parameters.query.slice(0, 120));
    if (parameters.cursor) query.set("cursor", parameters.cursor.slice(0, 160));
    redirect(`/settings/access?${query}`);
  }
  const services = await getPlatformServices();
  const projects = await services.identityAccess.listProjects(identity);
  const projectId = await selectedProjectId(identity, projects, "project.read");
  if (projectId) requireAuthorizedPageProjectScope(identity, "project.read", projectId);
  const project = projects.find((candidate) => candidate.id === projectId);
  const structure = project ? await services.projectStructures.list(project.id) : undefined;
  const hierarchy = await selectedProjectHierarchy(structure);
  const canManage = Boolean(
    project && !project.archived && hasPermission(identity, "project.manage", project.id),
  );

  return (
    <section className={cn("page-stack", uiPatterns["page-stack"])}>
      <header
        className={cn(
          "page-header settings-page-header",
          uiPatterns["page-header"],
          uiPatterns["settings-page-header"],
        )}
      >
        <div>
          <p className={cn("eyebrow", uiPatterns["eyebrow"])}>Organization</p>
          <h1>项目设置</h1>
          <p>管理项目负责人及版本执行资源；新建项目、版本和阶段请使用顶栏下拉列表。</p>
        </div>
      </header>
      <ProjectActions
        {...(project ? { project } : {})}
        canManage={canManage}
        key={project?.id ?? "none"}
      />
      {project && structure ? (
        <ProjectStructureManager
          key={`${project.id}:${hierarchy.projectVersionId ?? "none"}`}
          canManage={canManage}
          initialStructure={structure}
          {...(hierarchy.projectVersionId ? { initialVersionId: hierarchy.projectVersionId } : {})}
          projectId={project.id}
        />
      ) : (
        <p className={cn("inline-empty", uiPatterns["inline-empty"])}>当前账号没有可访问的项目。</p>
      )}
    </section>
  );
}
