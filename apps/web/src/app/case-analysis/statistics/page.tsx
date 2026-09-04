import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { BarChart3 } from "lucide-react";
import Link from "next/link";

import { FailureAnalysisStatistics } from "@/components/failure-analysis-statistics";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function FailureAnalysisStatisticsPage() {
  const { identity } = await requirePageProjectScope("audit.read");
  const services = await getPlatformServices();
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const projectId =
    (await selectedProjectId(identity, projects, "audit.read")) ?? DEFAULT_PROJECT_ID;
  requireAuthorizedPageProjectScope(identity, "audit.read", projectId);
  const hierarchy = await selectedProjectHierarchy(
    await services.projectStructures.list(projectId),
  );
  const initialPage = await services.failureAnalysis.statistics({
    projectId,
    ...(hierarchy.projectVersionId ? { projectVersionId: hierarchy.projectVersionId } : {}),
    limit: 50,
  });

  return (
    <div className="page-stack failure-analysis-statistics-page">
      <section className="page-hero">
        <div>
          <span className="eyebrow">Failure Analysis · Statistics</span>
          <h1>分析统计</h1>
          <p>查看人员认领、完成进度、结论分布，并按需审阅每一条分析内容。</p>
          <Link className="ui-button ui-button-secondary" href="/case-analysis">
            返回用例分析
          </Link>
        </div>
        <span className="hero-icon violet">
          <BarChart3 aria-hidden="true" size={24} />
        </span>
      </section>
      <FailureAnalysisStatistics
        initialPage={initialPage}
        projectId={projectId}
        {...(hierarchy.projectVersionId ? { projectVersionId: hierarchy.projectVersionId } : {})}
      />
    </div>
  );
}
