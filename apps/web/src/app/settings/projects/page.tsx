import { Button, Input } from "@/components/ui";
import Link from "next/link";
import { ProjectMembershipManager } from "@/components/project-membership-manager";
import { ProjectStructureManager } from "@/components/project-structure-manager";
import { SectionTabs } from "@/components/section-tabs";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";

export default async function ProjectMembershipsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; cursor?: string; query?: string }>;
}) {
  const { identity } = await requirePageProjectScope("project.read");
  const services = await getPlatformServices();
  const projects = await services.identities.listProjects(selectableProjectIds(identity));
  const parameters = await searchParams;
  const activeSection = parameters.section === "execution" ? "execution" : "members";
  const activeProjectId = await selectedProjectId(identity, projects, "project.read");
  if (activeProjectId) requireAuthorizedPageProjectScope(identity, "project.read", activeProjectId);
  const selectedProject = projects.find((project) => project.id === activeProjectId);

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
  const [memberPage, roles, structure] = await Promise.all([
    activeSection === "members"
      ? services.identityAccess.listProjectMembersPage(identity, selectedProject.id, {
          limit: 50,
          ...(parameters.cursor ? { cursor: parameters.cursor.slice(0, 160) } : {}),
          ...(parameters.query ? { query: parameters.query.slice(0, 120) } : {}),
        })
      : Promise.resolve({ items: [], nextCursor: undefined }),
    activeSection === "members"
      ? services.identityAccess.listProjectRolesForMemberManagement(identity, selectedProject.id)
      : Promise.resolve([]),
    activeSection === "execution"
      ? services.projectStructures.list(selectedProject.id)
      : Promise.resolve(undefined),
  ]);
  const hierarchy = structure ? await selectedProjectHierarchy(structure) : undefined;

  return (
    <section className="page-stack">
      <header className="page-header settings-page-header">
        <div>
          <p className="eyebrow">Projects</p>
          <h1>{activeSection === "members" ? "项目与成员" : "项目执行配置"}</h1>
          <p>
            {activeSection === "members"
              ? "查看成员角色；项目管理员可添加、移除成员并安全转移负责人。"
              : "管理项目版本、测试阶段、JDK 和测试依赖资源；Adapter 参数在用例任务中配置。"}
          </p>
        </div>
      </header>
      {activeSection === "members" ? (
        <form action="/settings/projects" className="settings-user-filter" method="get">
          <input name="section" type="hidden" value="members" />
          <label>
            搜索项目成员
            <Input name="query" defaultValue={parameters.query ?? ""} maxLength={120} />
          </label>
          <Button type="submit">筛选</Button>
          {memberPage.nextCursor ? (
            <Link
              className="button button-secondary"
              href={`/settings/projects?${new URLSearchParams({ section: "members", query: parameters.query ?? "", cursor: memberPage.nextCursor })}`}
            >
              下一页成员
            </Link>
          ) : null}
        </form>
      ) : null}
      <SectionTabs
        label="项目管理模块"
        tabs={[
          {
            href: `/settings/projects?${new URLSearchParams({
              section: "members",
            }).toString()}`,
            label: "成员与角色",
            active: activeSection === "members",
          },
          {
            href: `/settings/projects?${new URLSearchParams({
              section: "execution",
            }).toString()}`,
            label: "执行配置",
            active: activeSection === "execution",
          },
        ]}
      />
      {activeSection === "members" ? (
        <ProjectMembershipManager
          canManage={canManage}
          canCreateProject={identity.systemPermissions.includes("project.manage")}
          members={memberPage.items}
          project={selectedProject}
          roles={roles}
        />
      ) : structure ? (
        <ProjectStructureManager
          canManage={canManage}
          initialStructure={structure}
          {...(hierarchy?.projectVersionId ? { initialVersionId: hierarchy.projectVersionId } : {})}
          projectId={selectedProject.id}
        />
      ) : null}
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
