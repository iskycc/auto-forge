import { Layers3 } from "lucide-react";

import { CaseSuiteManager } from "@/components/case-suite-manager";
import { getPlatformServices } from "@/lib/services";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { DEFAULT_PROJECT_ID, hasPermission } from "@autoforge/domain";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";

export const dynamic = "force-dynamic";

export default async function CaseSuitesPage() {
  const { identity } = await requirePageProjectScope("case_suite.read");
  const services = await getPlatformServices();
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const activeProjectId =
    (await selectedProjectId(identity, projects, "case_suite.read")) ?? DEFAULT_PROJECT_ID;
  const effectiveProjectIds = requireAuthorizedPageProjectScope(
    identity,
    "case_suite.read",
    activeProjectId,
  );
  const structure = await services.projectStructures.list(activeProjectId);
  const hierarchy = await selectedProjectHierarchy(structure);
  const suites = hierarchy.projectVersionId
    ? await services.caseSuites.list(200, effectiveProjectIds, hierarchy.projectVersionId)
    : [];
  const selectedVersion = structure.versions.find(
    (version) => version.id === hierarchy.projectVersionId,
  );
  const canReadExecutions = hasPermission(identity, "run.read", activeProjectId);
  const activitySummary =
    canReadExecutions && hierarchy.projectVersionId
      ? await services.caseSuiteActivity.readSummary(
          { projectId: activeProjectId, projectVersionId: hierarchy.projectVersionId },
          suites.map((suite) => suite.id),
        )
      : undefined;
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">CaseSuite</span>
          <h1>用例任务</h1>
          <p>管理可复用的测试集合，查看近 7 天执行表现与最近执行记录。</p>
        </div>
        <span className="hero-icon violet">
          <Layers3 size={24} />
        </span>
      </section>
      <CaseSuiteManager
        key={`${activeProjectId}:${hierarchy.projectVersionId ?? ""}`}
        canManage={hasPermission(identity, "case_suite.manage", activeProjectId)}
        canReadExecutions={canReadExecutions}
        {...(activitySummary ? { activitySummary } : {})}
        initialSuites={suites}
        projectId={activeProjectId}
        {...(hierarchy.projectVersionId
          ? { selectedProjectVersionId: hierarchy.projectVersionId }
          : {})}
        {...(selectedVersion ? { selectedProjectVersionName: selectedVersion.name } : {})}
      />
    </div>
  );
}
