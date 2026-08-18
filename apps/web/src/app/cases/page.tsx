import { Button, Select } from "@/components/ui";

import { FileArchive, Import } from "lucide-react";
import Link from "next/link";

import { CaseSelectionTable } from "@/components/case-selection-table";
import { listCompleteCaseDirectory } from "@/lib/case-directory";
import { getPlatformServices } from "@/lib/services";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { projectIdsForPermission } from "@autoforge/domain";
import type { LatestCaseRunOutcome } from "@autoforge/application";

export const dynamic = "force-dynamic";

type CasesPageProps = {
  searchParams: Promise<{
    query?: string | string[];
    projectId?: string | string[];
    projectVersionId?: string | string[];
    testStageId?: string | string[];
  }>;
};

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CasesPage({ searchParams }: CasesPageProps) {
  const { identity, projectIds } = await requirePageProjectScope("case.read");
  const parameters = await searchParams;
  const query = single(parameters.query)?.trim();
  const requestedProjectId = single(parameters.projectId);
  const requestedProjectVersionId = single(parameters.projectVersionId);
  const requestedTestStageId = single(parameters.testStageId);
  const services = await getPlatformServices();
  const projects = await services.identityAccess.listProjects(identity).catch(() => []);
  const accessibleProjects = projects.filter(
    (project) => !projectIds || projectIds.includes(project.id),
  );
  const projectId = requestedProjectId ?? accessibleProjects[0]?.id;
  const effectiveProjectIds = requireAuthorizedPageProjectScope(identity, "case.read", projectId);
  const sourceManagementProjectIds = projectIdsForPermission(identity, "case_source.manage");
  const suiteManagementProjectIds = projectIdsForPermission(identity, "case_suite.manage");
  const canImport =
    sourceManagementProjectIds === undefined ||
    (projectId
      ? sourceManagementProjectIds.includes(projectId)
      : sourceManagementProjectIds.length > 0);
  const structure = projectId ? await services.projectStructures.list(projectId) : undefined;
  const projectVersion =
    structure?.versions.find((version) => version.id === requestedProjectVersionId) ??
    structure?.versions[0];
  const testStage =
    projectVersion?.stages.find((stage) => stage.id === requestedTestStageId) ??
    projectVersion?.stages[0];
  const [cases, suites] = await Promise.all([
    listCompleteCaseDirectory(services.catalog, {
      ...(effectiveProjectIds ? { projectIds: effectiveProjectIds } : {}),
      ...(projectVersion ? { projectVersionId: projectVersion.id } : {}),
      ...(testStage ? { testStageId: testStage.id } : {}),
      scopedOnly: true,
    }),
    services.caseSuites.list(200, effectiveProjectIds),
  ]);
  // 目录已按项目范围加载；这里直接取每用例最近终态执行结果，供筛选与统计使用。
  const latestRunOutcomes =
    cases.length > 0
      ? await services.caseDefinitions.latestRunOutcomes(
          cases.map((item) => item.id),
          effectiveProjectIds,
        )
      : [];
  const latestOutcomes = new Map<string, LatestCaseRunOutcome["outcome"]>(
    latestRunOutcomes.map((entry) => [entry.caseDefinitionId, entry.outcome]),
  );

  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">TestNG 资产</span>
          <h1>用例管理</h1>
          <p>一个 TestNG 测试类对应一个用例定义，测试方法作为可执行项保存在版本快照中。</p>
        </div>
        {canImport ? (
          <Link
            className="button button-primary button-large"
            href={
              projectId
                ? `/cases/import?${new URLSearchParams({
                    projectId,
                    ...(projectVersion ? { projectVersionId: projectVersion.id } : {}),
                    ...(testStage ? { testStageId: testStage.id } : {}),
                  }).toString()}`
                : "/cases/import"
            }
          >
            <Import size={18} aria-hidden="true" /> 导入 JAR
          </Link>
        ) : null}
      </section>

      <section className="card case-scope-toolbar" aria-label="用例范围">
        <div className="case-scope-heading">
          <strong>浏览范围</strong>
          <span>目录和用例在下方工作台中一次性完整加载。</span>
        </div>
        <div className="case-scope-filters">
          <form action="/cases" method="get">
            <Select aria-label="项目筛选" defaultValue={projectId ?? ""} name="projectId">
              <option value="">全部授权项目</option>
              {accessibleProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
            <Button className="button button-secondary" type="submit">
              切换项目
            </Button>
          </form>
          <form action="/cases" method="get">
            {projectId ? <input name="projectId" type="hidden" value={projectId} /> : null}
            <Select
              aria-label="版本筛选"
              defaultValue={projectVersion?.id ?? ""}
              name="projectVersionId"
            >
              {structure?.versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.name}
                </option>
              ))}
            </Select>
            <Select aria-label="测试阶段筛选" defaultValue={testStage?.id ?? ""} name="testStageId">
              {projectVersion?.stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </Select>
            <Button className="button button-secondary" type="submit">
              切换层级
            </Button>
          </form>
        </div>
      </section>

      {cases.length === 0 ? (
        <section className="card">
          <div className="empty-state">
            <span className="empty-icon">
              <FileArchive size={27} />
            </span>
            <strong>当前项目层级还没有用例</strong>
            <p>导入一个包含 TestNG @Test 注解的 JAR，或切换项目版本与测试阶段。</p>
            {canImport ? (
              <Link className="button button-primary" href="/cases/import">
                导入第一个 JAR
              </Link>
            ) : null}
          </div>
        </section>
      ) : (
        <CaseSelectionTable
          cases={cases}
          initialSearch={query ?? ""}
          latestOutcomes={latestOutcomes}
          suites={suites}
          manageableProjectIds={suiteManagementProjectIds}
        />
      )}
    </div>
  );
}
