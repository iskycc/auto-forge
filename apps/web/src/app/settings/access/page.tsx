import { AccessSettings } from "@/components/access-settings";
import { hasPermissionInAnyScope, requirePageAnyPermission } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { projectIdsForPermission } from "@autoforge/domain";
import Link from "next/link";

export default async function AccessSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ query?: string; source?: string; cursor?: string }>;
}) {
  const identity = await requirePageAnyPermission([
    "settings.read",
    "user.read",
    "role.read",
    "project.read",
    "ldap.read",
    "audit.read",
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
    auditRead: hasPermissionInAnyScope(identity, "audit.read"),
    canCreateProject: identity.systemPermissions.includes("project.manage"),
  };
  const manageableProjectIds = projectIdsForPermission(identity, "project.manage");
  const [userPage, roles, projects, ldap, ldapMappings, sessions, audit, systemRoleBindings] =
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
      capabilities.auditRead
        ? services.identityAccess.listAudit(identity, { limit: 100 })
        : Promise.resolve({ items: [], nextCursor: undefined }),
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
          <p>管理本地账号、LDAP、角色、项目作用域和安全审计。</p>
        </div>
        <nav className="settings-tabs" aria-label="系统设置分类">
          {capabilities.settingsRead ? <Link href="/settings">管理中心</Link> : null}
          {capabilities.settingsRead ? <Link href="/settings/platform">平台配置</Link> : null}
          <Link aria-current="page" href="/settings/access">
            身份与访问
          </Link>
          {capabilities.environmentRead ? (
            <Link href="/settings/environments">环境与密文</Link>
          ) : null}
        </nav>
      </header>
      <AccessSettings
        auditEvents={audit.items}
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
