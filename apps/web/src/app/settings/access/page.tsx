import { AccessSettings, type AccessSection } from "@/components/access-settings";
import { ManagementNavigation } from "@/components/management-navigation";
import { SectionTabs } from "@/components/section-tabs";
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
  const accessTabs = [
    ...(capabilities.userRead
      ? [{ id: "users" as const, label: "用户", href: "/settings/access?section=users" }]
      : []),
    ...(capabilities.roleRead
      ? [{ id: "roles" as const, label: "角色与权限", href: "/settings/access?section=roles" }]
      : []),
    ...(capabilities.projectRead
      ? [
          {
            id: "projects" as const,
            label: "项目作用域",
            href: "/settings/access?section=projects",
          },
        ]
      : []),
    ...(capabilities.ldapRead
      ? [{ id: "ldap" as const, label: "LDAP", href: "/settings/access?section=ldap" }]
      : []),
    { id: "sessions" as const, label: "当前会话", href: "/settings/access?section=sessions" },
  ];
  const requestedSection = requested.section as AccessSection | undefined;
  const activeSection =
    accessTabs.find((tab) => tab.id === requestedSection)?.id ?? accessTabs[0]!.id;
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
          <h1>身份与访问控制</h1>
          <p>管理本地账号、LDAP、角色、项目作用域和当前账号会话。</p>
        </div>
        <ManagementNavigation
          active="access"
          showAccess
          showEnvironments={capabilities.environmentRead}
          showOverview={capabilities.settingsRead}
          showPlatform={capabilities.settingsRead}
          showProjects={capabilities.projectRead}
        />
      </header>
      <SectionTabs
        label="身份与访问模块"
        tabs={accessTabs.map((tab) => ({
          href: tab.href,
          label: tab.label,
          active: tab.id === activeSection,
        }))}
      />
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
