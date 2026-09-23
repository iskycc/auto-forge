import { TabContent } from "@/components/ui/tab-content";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { AccessSettings, type AccessSection } from "@/components/access-settings";
import { hasPermissionInAnyScope, requirePageAnyPermission } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { OrganizationTabs, organizationSections } from "@/components/organization-tabs";
import { selectedProjectId } from "@/lib/selected-project";
import { hasPermission } from "@autoforge/domain";

export default async function AccessSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    section?: string;
    scope?: string;
    query?: string;
    source?: string;
    cursor?: string;
  }>;
}) {
  const identity = await requirePageAnyPermission([
    "project.read",
    "settings.read",
    "user.read",
    "role.read",
    "ldap.read",
  ]);
  const services = await getPlatformServices();
  const requested = await searchParams;
  const query = requested.query?.trim().slice(0, 120) || undefined;
  const source =
    requested.source === "local" || requested.source === "ldap" ? requested.source : undefined;
  const cursor = requested.cursor?.trim().slice(0, 128) || undefined;
  const capabilities = {
    settingsRead: hasPermissionInAnyScope(identity, "settings.read"),
    userRead: hasPermissionInAnyScope(identity, "user.read"),
    userManage: hasPermissionInAnyScope(identity, "user.manage"),
    roleRead: hasPermissionInAnyScope(identity, "role.read"),
    roleManage: hasPermissionInAnyScope(identity, "role.manage"),
    systemRoleAssign: hasPermission(identity, "role.manage"),
    projectRead: hasPermissionInAnyScope(identity, "project.read"),
    ldapRead: hasPermissionInAnyScope(identity, "ldap.read"),
    ldapManage: hasPermissionInAnyScope(identity, "ldap.manage"),
  };
  const availableSections = organizationSections(identity);
  const requestedSection = requested.section as AccessSection | undefined;
  const activeSection =
    availableSections.find((section) => section.id === requestedSection)?.id ??
    availableSections[0]!.id;
  const accessSection = activeSection as AccessSection;
  const heading = accessSectionHeading(accessSection);
  // Load only the active section and visible user page; project readers never query global accounts.
  const needsRoles = activeSection === "users" || activeSection === "roles";
  const projects =
    needsRoles && capabilities.projectRead
      ? await services.identityAccess.listProjects(identity)
      : [];
  const projectId = await selectedProjectId(identity, projects, "project.read");
  const currentProject = projects.find((project) => project.id === projectId);
  const projectScope =
    activeSection === "users" &&
    capabilities.projectRead &&
    (requested.scope === "project" || !capabilities.userRead);
  const [memberPage, globalUserPage, roles, ldap, sessions] = await Promise.all([
    projectScope && currentProject
      ? services.identityAccess.listProjectMembersPage(identity, currentProject.id, {
          limit: 50,
          ...(query ? { query } : {}),
          ...(cursor ? { cursor } : {}),
        })
      : Promise.resolve({ items: [], nextCursor: undefined }),
    needsRoles && capabilities.userRead && !projectScope
      ? services.identityAccess.listUsers(identity, {
          limit: 50,
          ...(query ? { query } : {}),
          ...(source ? { source } : {}),
          ...(cursor ? { cursor } : {}),
        })
      : Promise.resolve({ items: [], nextCursor: undefined }),
    needsRoles && capabilities.roleRead
      ? services.identityAccess.listRoles(identity)
      : needsRoles && currentProject
        ? services.identityAccess.listProjectRolesForMemberManagement(identity, currentProject.id)
        : Promise.resolve([]),
    activeSection === "ldap" && capabilities.ldapRead
      ? services.identityAccess.getLdapConfiguration(identity)
      : Promise.resolve(null),
    activeSection === "sessions"
      ? services.identityAccess.listSessions(identity)
      : Promise.resolve([]),
  ]);
  const userPage = projectScope
    ? { items: memberPage.items.map((member) => member.user), nextCursor: memberPage.nextCursor }
    : globalUserPage;
  const userIds = userPage.items.map((user) => user.id);
  const bindingsPage =
    activeSection === "roles" && capabilities.roleRead && !capabilities.userRead
      ? await services.identityAccess.listSystemRoleBindingsPage(identity, cursor)
      : undefined;
  const [systemRoleBindings, projectBindings] = await Promise.all([
    needsRoles && capabilities.roleRead && !projectScope
      ? (bindingsPage?.items ?? services.identityAccess.listSystemRoleBindings(identity, userIds))
      : [],
    activeSection === "users" && capabilities.projectRead && !projectScope
      ? services.identityAccess.listUserProjectRoleBindings(identity, userIds)
      : [],
  ]);
  const membershipsByProject = new Map<string, Map<string, string[]>>();
  for (const binding of projectBindings) {
    const members = membershipsByProject.get(binding.projectId) ?? new Map<string, string[]>();
    members.set(binding.userId, [...(members.get(binding.userId) ?? []), binding.roleId]);
    membershipsByProject.set(binding.projectId, members);
  }
  const projectMemberships =
    projectScope && currentProject
      ? [{ projectId: currentProject.id, members: memberPage.items }]
      : [...membershipsByProject].map(([projectId, members]) => ({
          projectId,
          members: userPage.items
            .filter((user) => members.has(user.id))
            .map((user) => ({ user, roleIds: members.get(user.id)! })),
        }));

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
          <h1>{heading.title}</h1>
          <p>{heading.description}</p>
        </div>
      </header>
      <OrganizationTabs identity={identity} activeSection={activeSection} />
      <TabContent activeKey={activeSection} className="gap-5">
        <AccessSettings
          currentSessionId={identity.sessionId}
          activeSection={accessSection}
          capabilities={{
            ...capabilities,
            userRead: capabilities.userRead || capabilities.projectRead,
            userManage: capabilities.userManage && !projectScope,
            roleRead: capabilities.roleRead || capabilities.projectRead,
            systemRoleAssign: capabilities.systemRoleAssign && !projectScope,
          }}
          canReadSystemRoles={capabilities.roleRead}
          canReadAllUsers={capabilities.userRead}
          projectScope={projectScope}
          {...(currentProject ? { currentProject } : {})}
          ldap={ldap}
          projects={projects}
          assignableProjectIds={projects
            .filter(
              (project) =>
                !project.archived &&
                hasPermission(identity, "project.manage", project.id) &&
                (!projectScope || project.id === currentProject?.id),
            )
            .map((project) => project.id)}
          projectMemberships={projectMemberships}
          roles={roles}
          sessions={sessions}
          systemRoleBindings={systemRoleBindings}
          users={userPage.items}
          userQuery={query ?? ""}
          userSource={source ?? ""}
          nextUserCursor={bindingsPage?.nextCursor ?? userPage.nextCursor}
          // Query-string Tab navigation preserves client component state. Include the LDAP
          // configuration version so entering the lazily loaded directory tab and saving a new
          // revision both remount controlled switches from the authoritative persisted values.
          key={`${activeSection}:${projectScope ? currentProject?.id : "all"}:${ldap?.updatedAt ?? "none"}`}
        />
      </TabContent>
    </section>
  );
}

function accessSectionHeading(section: AccessSection): {
  title: string;
  description: string;
  tab: string;
} {
  switch (section) {
    case "users":
      return {
        title: "用户管理",
        description: "统一管理平台账号与项目成员，在用户行直接分配或撤销角色。",
        tab: "用户管理",
      };
    case "roles":
      return {
        title: "角色与权限",
        description: "统一查看系统与项目角色。系统角色全局生效，项目角色只在分配的项目内生效。",
        tab: "角色权限",
      };
    case "ldap":
      return {
        title: "LDAP 目录",
        description: "配置目录连接、登录属性和统一默认角色。",
        tab: "目录配置",
      };
    case "sessions":
      return {
        title: "登录会话",
        description: "查看并终止当前账号的活动登录会话。",
        tab: "登录会话",
      };
  }
}
