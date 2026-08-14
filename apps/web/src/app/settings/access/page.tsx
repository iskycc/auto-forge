import { AccessSettings, type AccessSection } from "@/components/access-settings";
import { hasPermissionInAnyScope, requirePageAnyPermission } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { projectIdsForPermission } from "@autoforge/domain";

export default async function AccessSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    section?: string;
    query?: string;
    source?: string;
    cursor?: string;
  }>;
}) {
  const identity = await requirePageAnyPermission([
    "settings.read",
    "user.read",
    "role.read",
    "project.read",
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
    environmentRead: hasPermissionInAnyScope(identity, "environment.read"),
    userRead: hasPermissionInAnyScope(identity, "user.read"),
    userManage: hasPermissionInAnyScope(identity, "user.manage"),
    roleRead: hasPermissionInAnyScope(identity, "role.read"),
    roleManage: hasPermissionInAnyScope(identity, "role.manage"),
    projectRead: hasPermissionInAnyScope(identity, "project.read"),
    ldapRead: hasPermissionInAnyScope(identity, "ldap.read"),
    ldapManage: hasPermissionInAnyScope(identity, "ldap.manage"),
    canCreateProject: identity.systemPermissions.includes("project.manage"),
  };
  const availableSections = [
    ...(capabilities.userRead ? [{ id: "users" as const }] : []),
    ...(capabilities.roleRead ? [{ id: "roles" as const }] : []),
    ...(capabilities.projectRead ? [{ id: "projects" as const }] : []),
    ...(capabilities.ldapRead ? [{ id: "ldap" as const }] : []),
    { id: "sessions" as const },
  ];
  const requestedSection = requested.section as AccessSection | undefined;
  const activeSection =
    availableSections.find((section) => section.id === requestedSection)?.id ??
    availableSections[0]!.id;
  const heading = accessSectionHeading(activeSection);
  const manageableProjectIds = projectIdsForPermission(identity, "project.manage");
  const [userPage, roles, projects, ldap, ldapMappings, sessions, systemRoleBindings] =
    await Promise.all([
      capabilities.userRead
        ? services.identityAccess.listUsers(identity, {
            limit: 50,
            ...(query ? { query } : {}),
            ...(source ? { source } : {}),
            ...(cursor ? { cursor } : {}),
          })
        : Promise.resolve({ items: [], nextCursor: undefined }),
      capabilities.roleRead ? services.identityAccess.listRoles(identity) : Promise.resolve([]),
      capabilities.projectRead
        ? services.identityAccess.listProjects(identity)
        : Promise.resolve([]),
      capabilities.ldapRead
        ? services.identityAccess.getLdapConfiguration(identity)
        : Promise.resolve(null),
      capabilities.ldapRead
        ? services.identityAccess.listLdapGroupMappings(identity)
        : Promise.resolve([]),
      services.identityAccess.listSessions(identity),
      capabilities.roleRead
        ? services.identityAccess.listSystemRoleBindings(identity)
        : Promise.resolve([]),
    ]);
  const projectMemberships = await Promise.all(
    projects.map(async (project) => ({
      projectId: project.id,
      members: await services.identityAccess.listProjectMembers(identity, project.id),
    })),
  );

  return (
    <section className="page-stack">
      <header className="page-header settings-page-header">
        <div>
          <p className="eyebrow">System Settings</p>
          <h1>{heading.title}</h1>
          <p>{heading.description}</p>
        </div>
      </header>
      <AccessSettings
        activeSection={activeSection}
        capabilities={capabilities}
        ldap={ldap}
        ldapMappings={ldapMappings}
        manageableProjectIds={manageableProjectIds ?? null}
        projects={projects}
        projectMemberships={projectMemberships}
        roles={roles}
        sessions={sessions}
        systemRoleBindings={systemRoleBindings}
        users={userPage.items}
        userQuery={query ?? ""}
        userSource={source ?? ""}
        nextUserCursor={userPage.nextCursor}
      />
    </section>
  );
}

function accessSectionHeading(section: AccessSection): { title: string; description: string } {
  switch (section) {
    case "users":
      return { title: "用户管理", description: "管理本地账号、账号状态和用户来源。" };
    case "roles":
      return { title: "角色与权限", description: "管理系统角色、权限集合和系统级绑定。" };
    case "projects":
      return { title: "项目角色", description: "查看项目成员及其项目作用域角色。" };
    case "ldap":
      return { title: "LDAP 目录", description: "配置离线目录连接、组映射和同步规则。" };
    case "sessions":
      return { title: "登录会话", description: "查看并终止当前账号的活动登录会话。" };
  }
}
