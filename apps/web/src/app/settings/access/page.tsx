import { AccessSettings } from "@/components/access-settings";
import { requirePagePermission } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export default async function AccessSettingsPage() {
  const identity = await requirePagePermission("settings.read", undefined);
  const services = await getPlatformServices();
  const [userPage, roles, projects, ldap, ldapMappings, sessions, audit] = await Promise.all([
    services.identityAccess.listUsers(identity, { limit: 200 }),
    services.identityAccess.listRoles(identity),
    services.identityAccess.listProjects(identity),
    services.identityAccess.getLdapConfiguration(identity),
    services.identityAccess.listLdapGroupMappings(identity),
    services.identityAccess.listSessions(identity),
    services.identityAccess.listAudit(identity, { limit: 100 }),
  ]);

  return (
    <section className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">System Settings</p>
          <h1>身份与访问控制</h1>
          <p>管理本地账号、LDAP、角色、项目作用域和安全审计。</p>
        </div>
      </header>
      <AccessSettings
        auditEvents={audit.items}
        ldap={ldap}
        ldapMappings={ldapMappings}
        projects={projects}
        roles={roles}
        sessions={sessions}
        users={userPage.items}
      />
    </section>
  );
}
