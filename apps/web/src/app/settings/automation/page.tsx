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
  const identity = await requirePageAnyPermission(["case_suite.read"]);
  const services = await getPlatformServices();
  const canReadSchedules = hasPermissionInAnyScope(identity, "case_suite.read");
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
  const [allSchedules, suites] = await Promise.all([
    canReadSchedules ? services.platformOperations.listSchedules(identity) : Promise.resolve([]),
    canReadSchedules && hierarchy.projectVersionId
      ? services.caseSuites.list(
          500,
          projectId ? [projectId] : scheduleProjectIds,
          hierarchy.projectVersionId,
        )
      : Promise.resolve([]),
  ]);
  const visibleSuiteIds = new Set(suites.map((suite) => suite.id));
  const schedules = allSchedules.filter((schedule) => visibleSuiteIds.has(schedule.suiteId));

  return (
    <section className="page-stack">
      <header className="page-header settings-page-header">
        <div>
          <p className="eyebrow">Automation</p>
          <h1>计划任务</h1>
          <p>统一查看计划任务的触发状态与关联批次。</p>
        </div>
      </header>
      <AutomationOperations
        manageableScheduleProjectIds={projectIdsForPermission(identity, "case_suite.manage")}
        schedules={schedules}
        suites={suites.map((suite) => ({ id: suite.id, name: suite.name }))}
      />
    </section>
  );
}
