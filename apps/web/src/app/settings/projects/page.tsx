import { ManagementNavigation } from "@/components/management-navigation";
import { ProjectMembershipManager } from "@/components/project-membership-manager";
import { ProjectStructureManager } from "@/components/project-structure-manager";
import {
  hasPermissionInAnyScope,
  requireAuthorizedPageProjectScope,
  requirePageProjectScope,
} from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export default async function ProjectMembershipsPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>;
}) {
  const { identity } = await requirePageProjectScope("project.read");
  const services = await getPlatformServices();
  const projects = await services.identityAccess.listProjects(identity);
  const requestedProjectId = (await searchParams).projectId?.trim();
  if (requestedProjectId) {
    requireAuthorizedPageProjectScope(identity, "project.read", requestedProjectId);
  }
  const selectedProject =
    projects.find((project) => project.id === requestedProjectId) ?? projects[0];

  if (!selectedProject) {
    return (
      <section className="page-stack">
        <header className="page-header">
          <div>
            <p className="eyebrow">Projects</p>
            <h1>项目与成员</h1>
            <p>当前账号没有可访问的项目。</p>
          </div>
        </header>
      </section>
    );
  }

  const canManage = canManageProject(services, identity, selectedProject.id);
  const [members, roles, structure] = await Promise.all([
    services.identityAccess.listProjectMembers(identity, selectedProject.id),
    services.identityAccess.listProjectRolesForMemberManagement(identity, selectedProject.id),
    services.projectStructures.list(selectedProject.id),
  ]);

  return (
    <section className="page-stack">
      <header className="page-header settings-page-header">
        <div>
          <p className="eyebrow">Projects</p>
          <h1>项目与成员</h1>
          <p>查看成员角色；项目管理员可添加、移除成员并安全转移负责人。</p>
        </div>
        <ManagementNavigation
          active="projects"
          showAccess={
            hasPermissionInAnyScope(identity, "settings.read") ||
            hasPermissionInAnyScope(identity, "user.read") ||
            hasPermissionInAnyScope(identity, "role.read") ||
            hasPermissionInAnyScope(identity, "ldap.read")
          }
          showEnvironments={
            hasPermissionInAnyScope(identity, "environment.read") ||
            hasPermissionInAnyScope(identity, "secret.manage")
          }
          showOverview={hasPermissionInAnyScope(identity, "settings.read")}
          showPlatform={hasPermissionInAnyScope(identity, "settings.read")}
          showProjects
        />
      </header>
      <ProjectMembershipManager
        canManage={canManage}
        members={members}
        project={selectedProject}
        projects={projects}
        roles={roles}
      />
      <ProjectStructureManager
        canManage={canManage}
        initialStructure={structure}
        projectId={selectedProject.id}
      />
    </section>
  );
}

function canManageProject(
  services: Awaited<ReturnType<typeof getPlatformServices>>,
  identity: Awaited<ReturnType<typeof requirePageProjectScope>>["identity"],
  projectId: string,
): boolean {
  try {
    services.identityAccess.authorize(identity, "project.manage", projectId);
    return true;
  } catch {
    return false;
  }
}
