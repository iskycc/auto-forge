import { projectIdsForPermission } from "@autoforge/domain";
import Link from "next/link";

import { AutomationOperations } from "@/components/automation-operations";
import { SectionTabs } from "@/components/section-tabs";
import { hasPermissionInAnyScope, requirePageAnyPermission } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export default async function AutomationOperationsPage() {
  const identity = await requirePageAnyPermission(["case_suite.read", "ldap.read"]);
  const services = await getPlatformServices();
  const canReadSchedules = hasPermissionInAnyScope(identity, "case_suite.read");
  const canReadLdap = hasPermissionInAnyScope(identity, "ldap.read");
  const canReadSettings = hasPermissionInAnyScope(identity, "settings.read");
  const canReadAudit = hasPermissionInAnyScope(identity, "audit.read");
  const scheduleProjectIds = canReadSchedules
    ? projectIdsForPermission(identity, "case_suite.read")
    : [];
  const [schedules, suites, ldapJobs] = await Promise.all([
    canReadSchedules ? services.platformOperations.listSchedules(identity) : Promise.resolve([]),
    canReadSchedules ? services.caseSuites.list(500, scheduleProjectIds) : Promise.resolve([]),
    canReadLdap ? services.platformOperations.listLdapSyncJobs(identity, 100) : Promise.resolve([]),
  ]);

  return (
    <section className="page-stack">
      <header className="page-header settings-page-header">
        <div>
          <p className="eyebrow">Automation</p>
          <h1>计划与目录作业</h1>
          <p>统一查看计划任务的触发状态、关联批次，以及 LDAP 同步进度和失败诊断。</p>
        </div>
        <SectionTabs
          label="运维与审计"
          tabs={[
            { href: "/settings/automation", label: "运维计划", active: true },
            ...(canReadAudit ? [{ href: "/audit", label: "安全审计", active: false }] : []),
          ]}
        />
        <div className="page-context-links">
          {canReadSettings ? <Link href="/settings">返回管理中心</Link> : null}
          {canReadLdap ? <Link href="/settings/access?section=ldap">LDAP 配置</Link> : null}
        </div>
      </header>
      <AutomationOperations
        canManageLdap={hasPermissionInAnyScope(identity, "ldap.manage")}
        ldapJobs={ldapJobs}
        manageableScheduleProjectIds={projectIdsForPermission(identity, "case_suite.manage")}
        schedules={schedules}
        suites={suites.map((suite) => ({ id: suite.id, name: suite.name }))}
      />
    </section>
  );
}
