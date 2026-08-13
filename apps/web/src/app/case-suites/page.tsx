import { Layers3 } from "lucide-react";

import { CaseSuiteManager } from "@/components/case-suite-manager";
import { getPlatformServices } from "@/lib/services";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function CaseSuitesPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string | string[] }>;
}) {
  const { identity, projectIds } = await requirePageProjectScope("case_suite.read");
  const requested = (await searchParams).projectId;
  const requestedProjectId = (Array.isArray(requested) ? requested[0] : requested)?.trim();
  const selectedProjectId = requestedProjectId ?? projectIds?.[0];
  const effectiveProjectIds = requireAuthorizedPageProjectScope(
    identity,
    "case_suite.read",
    selectedProjectId,
  );
  const services = await getPlatformServices();
  const [suites, projects] = await Promise.all([
    services.caseSuites.list(200, effectiveProjectIds),
    services.identityAccess.listProjects(identity).catch(() => []),
  ]);
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">CaseSuite</span>
          <h1>用例任务</h1>
          <p>创建可复用的测试集合，从用例库批量添加或随时移除用例。</p>
        </div>
        <span className="hero-icon violet">
          <Layers3 size={24} />
        </span>
      </section>
      <CaseSuiteManager
        initialSuites={suites}
        projectId={selectedProjectId}
        projects={projects
          .filter((project) => !projectIds || projectIds.includes(project.id))
          .map(({ id, name }) => ({ id, name }))}
      />
    </div>
  );
}
