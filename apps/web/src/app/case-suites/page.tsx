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
  const [suites, structure] = await Promise.all([
    services.caseSuites.list(200, effectiveProjectIds),
    services.projectStructures.list(activeProjectId),
  ]);
  const hierarchy = await selectedProjectHierarchy(structure);
  const selectedVersion = structure.versions.find(
    (version) => version.id === hierarchy.projectVersionId,
  );
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">CaseSuite</span>
          <h1>用例任务</h1>
          <p>创建可复用的测试集合，从用例管理批量添加或随时移除用例。</p>
        </div>
        <span className="hero-icon violet">
          <Layers3 size={24} />
        </span>
      </section>
      <CaseSuiteManager
        canManage={hasPermission(identity, "case_suite.manage", activeProjectId)}
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
