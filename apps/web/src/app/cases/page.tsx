import { DatabaseZap, FileArchive, Import } from "lucide-react";
import Link from "next/link";

import { CaseSelectionTable } from "@/components/case-selection-table";
import { DdtManagementWorkspace } from "@/components/ddt-management-workspace";
import { listCompleteCaseDirectory } from "@/lib/case-directory";
import { getPlatformServices } from "@/lib/services";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";
import { projectIdsForPermission } from "@autoforge/domain";
import type { CaseLatestRun } from "@/lib/case-selection-stats";

export const dynamic = "force-dynamic";

type CasesPageProps = {
  searchParams: Promise<{
    query?: string | string[];
    tab?: string | string[];
  }>;
};

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CasesPage({ searchParams }: CasesPageProps) {
  const { identity } = await requirePageProjectScope("case.read");
  const parameters = await searchParams;
  const query = single(parameters.query)?.trim();
  const activeTab = single(parameters.tab) === "ddt" ? "ddt" : "testng";
  const services = await getPlatformServices();
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const projectId = await selectedProjectId(identity, projects, "case.read");
  const effectiveProjectIds = requireAuthorizedPageProjectScope(identity, "case.read", projectId);
  const sourceManagementProjectIds = projectIdsForPermission(identity, "case_source.manage");
  const suiteManagementProjectIds = projectIdsForPermission(identity, "case_suite.manage");
  const caseManagementProjectIds = projectIdsForPermission(identity, "case.manage");
  const canImport =
    sourceManagementProjectIds === undefined ||
    (projectId
      ? sourceManagementProjectIds.includes(projectId)
      : sourceManagementProjectIds.length > 0);
  const structure = projectId ? await services.projectStructures.list(projectId) : undefined;
  const hierarchy = await selectedProjectHierarchy(structure);
  const projectVersion = structure?.versions.find(
    (version) => version.id === hierarchy.projectVersionId,
  );
  const testStage = projectVersion?.stages.find((stage) => stage.id === hierarchy.testStageId);
  const [cases, suites] =
    activeTab === "testng"
      ? await Promise.all([
          listCompleteCaseDirectory(services.catalog, {
            ...(effectiveProjectIds ? { projectIds: effectiveProjectIds } : {}),
            ...(projectVersion ? { projectVersionId: projectVersion.id } : {}),
            ...(testStage ? { testStageId: testStage.id } : {}),
            scopedOnly: true,
          }),
          projectVersion
            ? services.caseSuites.list(200, effectiveProjectIds, projectVersion.id)
            : Promise.resolve([]),
        ])
      : [[], []];
  // 目录已按项目范围加载；这里直接取每用例最近终态执行结果，供筛选与统计使用。
  const latestRunOutcomes =
    activeTab === "testng" && cases.length > 0
      ? await services.caseDefinitions.latestRunOutcomes(
          cases.map((item) => item.id),
          effectiveProjectIds,
        )
      : [];
  const latestOutcomes = new Map<string, CaseLatestRun>(
    latestRunOutcomes.map((entry) => [
      entry.caseDefinitionId,
      {
        outcome: entry.outcome,
        ...(entry.resultCode ? { resultCode: entry.resultCode } : {}),
      },
    ]),
  );

  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">{activeTab === "ddt" ? "数据驱动测试" : "TestNG 资产"}</span>
          <h1>用例管理</h1>
          <p>
            {activeTab === "ddt"
              ? "在当前项目版本与测试阶段内管理动态字段用例、用户旅程、模板和导入来源。"
              : "一个 TestNG 测试类对应一个用例定义，测试方法作为可执行项保存在版本快照中。"}
          </p>
        </div>
        {canImport && activeTab === "testng" ? (
          <Link className="button button-primary button-large" href="/cases/import">
            <Import size={18} aria-hidden="true" /> 导入 JAR
          </Link>
        ) : null}
      </section>

      <nav className="case-kind-tabs" aria-label="用例类型">
        <Link className={activeTab === "testng" ? "active" : ""} href="/cases?tab=testng">
          <FileArchive size={17} aria-hidden="true" /> TestNG 用例
        </Link>
        <Link className={activeTab === "ddt" ? "active" : ""} href="/cases?tab=ddt">
          <DatabaseZap size={17} aria-hidden="true" /> DDT 管理
        </Link>
      </nav>

      <section className="card case-scope-toolbar" aria-label="用例范围">
        <div className="case-scope-heading">
          <strong>浏览范围</strong>
          <span>由顶栏项目层级统一控制；目录和用例在下方工作台中完整加载。</span>
        </div>
        <div className="case-scope-current" aria-label="当前用例层级">
          <span>
            <small>项目版本</small>
            <strong>{projectVersion?.name ?? "尚未配置"}</strong>
          </span>
          <span>
            <small>测试阶段</small>
            <strong>{testStage?.name ?? "尚未配置"}</strong>
          </span>
        </div>
      </section>

      {activeTab === "ddt" ? (
        projectId && projectVersion && testStage ? (
          <DdtManagementWorkspace
            scope={{
              projectId,
              projectVersionId: projectVersion.id,
              testStageId: testStage.id,
            }}
            canManage={
              caseManagementProjectIds === undefined || caseManagementProjectIds.includes(projectId)
            }
          />
        ) : (
          <section className="card case-library-empty-card">
            <div className="empty-state case-library-empty">
              <span className="empty-icon">
                <DatabaseZap size={27} />
              </span>
              <strong>请先选择完整的项目层级</strong>
              <p>DDT 用例严格绑定项目、项目版本和测试阶段，配置完整后即可开始导入。</p>
            </div>
          </section>
        )
      ) : cases.length === 0 ? (
        <section className="card case-library-empty-card">
          <div className="empty-state case-library-empty">
            <span className="empty-icon">
              <FileArchive size={27} />
            </span>
            <strong>当前项目层级还没有用例</strong>
            <p>导入一个包含 TestNG @Test 注解的 JAR，或在顶栏调整项目版本与测试阶段。</p>
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
          caseManagementProjectIds={caseManagementProjectIds}
          suiteManagementProjectIds={suiteManagementProjectIds}
        />
      )}
    </div>
  );
}
