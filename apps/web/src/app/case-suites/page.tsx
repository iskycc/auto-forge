import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { caseSuiteActivitySummarySchema } from "@autoforge/contracts";
import { ReadModelStatusBar } from "@/components/read-model-status";
import { Layers3 } from "lucide-react";

import { CaseSuiteManager } from "@/components/case-suite-manager";
import { caseSuiteAdapterDefaults } from "@/lib/case-suite-adapter-defaults";
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
  const activityProjection =
    canReadExecutions && hierarchy.projectVersionId
      ? await services.readModels.read({
          kind: "suite_activity",
          projectId: activeProjectId,
          projectVersionId: hierarchy.projectVersionId,
          suiteIds: suites.map((suite) => suite.id),
        })
      : undefined;
  const activitySummary = activityProjection?.generation
    ? caseSuiteActivitySummarySchema.parse(activityProjection.payload)
    : undefined;
  return (
    <div className={cn("page-stack", uiPatterns["page-stack"])}>
      <section className={cn("page-hero", uiPatterns["page-hero"])}>
        <div>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>CaseSuite</span>
          <h1>用例任务</h1>
          <p>管理可复用的测试集合，查看近 7 天执行表现与最近执行记录。</p>
        </div>
        <span className={cn("hero-icon violet", pageStyles["hero-icon"])}>
          <Layers3 size={24} />
        </span>
      </section>
      {activityProjection ? <ReadModelStatusBar snapshots={[activityProjection.status]} /> : null}
      <CaseSuiteManager
        key={`${activeProjectId}:${hierarchy.projectVersionId ?? ""}:${hierarchy.testStageId ?? ""}`}
        adapterNameDefaults={caseSuiteAdapterDefaults(
          projects.find((project) => project.id === activeProjectId)?.name ?? "",
          selectedVersion,
          hierarchy.testStageId,
        )}
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

const pageStyles = {
  "hero-icon":
    "inline-flex items-center gap-2 border border-solid border-border rounded-lg p-0 bg-card text-muted-foreground text-xs font-semibold shadow-xs w-12 h-12 justify-center [&.violet]:bg-muted [&.violet]:text-info",
} as const;
