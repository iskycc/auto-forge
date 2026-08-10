import { AccessSettings } from "@/components/access-settings";
import { requirePagePermission } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import Link from "next/link";

export default async function AccessSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ query?: string; source?: string; cursor?: string }>;
}) {
  const identity = await requirePagePermission("settings.read", undefined);
  const services = await getPlatformServices();
  const requested = await searchParams;
  const query = requested.query?.trim().slice(0, 120) || undefined;
  const source =
    requested.source === "local" || requested.source === "ldap" ? requested.source : undefined;
  const cursor = requested.cursor?.trim().slice(0, 128) || undefined;
  const [userPage, roles, projects, ldap, ldapMappings, sessions, audit] = await Promise.all([
    services.identityAccess.listUsers(identity, {
      limit: 50,
      ...(query ? { query } : {}),
      ...(source ? { source } : {}),
      ...(cursor ? { cursor } : {}),
    }),
    services.identityAccess.listRoles(identity),
    services.identityAccess.listProjects(identity),
    services.identityAccess.getLdapConfiguration(identity),
    services.identityAccess.listLdapGroupMappings(identity),
    services.identityAccess.listSessions(identity),
    services.identityAccess.listAudit(identity, { limit: 100 }),
  ]);

  return (
    <section className="page-stack">
      <header className="page-header settings-page-header">
        <div>
          <p className="eyebrow">System Settings</p>
          <h1>身份与访问控制</h1>
          <p>管理本地账号、LDAP、角色、项目作用域和安全审计。</p>
        </div>
        <nav className="settings-tabs" aria-label="系统设置分类">
          <Link aria-current="page" href="/settings/access">
            身份与访问
          </Link>
          <Link href="/settings/environments">环境与密文</Link>
        </nav>
      </header>
      <AccessSettings
        auditEvents={audit.items}
        ldap={ldap}
        ldapMappings={ldapMappings}
        projects={projects}
        roles={roles}
        sessions={sessions}
        users={userPage.items}
        userQuery={query ?? ""}
        userSource={source ?? ""}
        nextUserCursor={userPage.nextCursor}
      />
    </section>
  );
}
