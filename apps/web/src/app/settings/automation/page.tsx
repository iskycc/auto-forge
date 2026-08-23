import { projectIdsForPermission } from "@autoforge/domain";

import { AutomationOperations } from "@/components/automation-operations";
import { hasPermissionInAnyScope, requirePageAnyPermission } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";

export default async function AutomationOperationsPage() {
  const identity = await requirePageAnyPermission(["case_suite.read", "ldap.read"]);
  const services = await getPlatformServices();
  const canReadSchedules = hasPermissionInAnyScope(identity, "case_suite.read");
  const canReadLdap = hasPermissionInAnyScope(identity, "ldap.read");
  const scheduleProjectIds = canReadSchedules
    ? projectIdsForPermission(identity, "case_suite.read")
    : [];
  const projects = canReadSchedules
    ? await services.identities.listProjects(selectableProjectIds(identity)).catch(() => [])
    : [];
  const projectId = canReadSchedules
    ? await selectedProjectId(identity, projects, "case_suite.read")
    : undefined;
  const hierarchy = await selectedProjectHierarchy(
    projectId ? await services.projectStructures.list(projectId).catch(() => undefined) : undefined,
  );
  const [allSchedules, suites, ldapJobs] = await Promise.all([
    canReadSchedules ? services.platformOperations.listSchedules(identity) : Promise.resolve([]),
    canReadSchedules && hierarchy.projectVersionId
      ? services.caseSuites.list(
          500,
          projectId ? [projectId] : scheduleProjectIds,
          hierarchy.projectVersionId,
        )
      : Promise.resolve([]),
    canReadLdap ? services.platformOperations.listLdapSyncJobs(identity, 100) : Promise.resolve([]),
  ]);
  const visibleSuiteIds = new Set(suites.map((suite) => suite.id));
  const schedules = allSchedules.filter((schedule) => visibleSuiteIds.has(schedule.suiteId));

  return (
    <section className="page-stack">
      <header className="page-header settings-page-header">
        <div>
          <p className="eyebrow">Automation</p>
          <h1>计划与目录作业</h1>
          <p>统一查看计划任务的触发状态、关联批次，以及 LDAP 同步进度和失败诊断。</p>
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
