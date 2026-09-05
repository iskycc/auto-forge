import { DatabaseZap } from "lucide-react";

import { CachedCaseDirectory } from "@/components/cached-case-directory";
import { caseDirectoryManifestSchema } from "@autoforge/contracts";
import { CaseManagementTabs } from "@/components/case-management-tabs";
import { DdtManagementWorkspace } from "@/components/ddt-management-workspace";
import { getPlatformServices } from "@/lib/services";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";
import { projectIdsForPermission } from "@autoforge/domain";

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
  const [directoryProjection, suites] = await Promise.all([
    projectId && projectVersion && testStage
      ? services.readModels.read({
          kind: "case_directory",
          projectId,
          projectVersionId: projectVersion.id,
          testStageId: testStage.id,
        })
      : Promise.resolve(null),
    projectVersion
      ? services.caseSuites.list(200, effectiveProjectIds, projectVersion.id)
      : Promise.resolve([]),
  ]);
  const directoryManifest = directoryProjection?.generation
    ? caseDirectoryManifestSchema.parse(directoryProjection.payload)
    : null;

  return (
    <div className="page-stack">
      <CaseManagementTabs
        canImport={canImport}
        ddtContent={
          projectId && projectVersion && testStage ? (
            <DdtManagementWorkspace
              key={`${projectId}:${projectVersion.id}:${testStage.id}`}
              scope={{
                projectId,
                projectVersionId: projectVersion.id,
                testStageId: testStage.id,
              }}
              canManage={
                caseManagementProjectIds === undefined ||
                caseManagementProjectIds.includes(projectId)
              }
              canManageSuites={
                suiteManagementProjectIds === undefined ||
                suiteManagementProjectIds.includes(projectId)
              }
              suites={suites.map((suite) => ({ id: suite.id, name: suite.name }))}
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
        }
        initialTab={activeTab}
        scopeContent={
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
        }
        testngContent={
          directoryProjection ? (
            <CachedCaseDirectory
              key={directoryProjection.id}
              snapshot={directoryProjection.status}
              manifest={directoryManifest}
              userId={identity.user.id}
              canImport={canImport}
              suites={suites}
              caseManagementProjectIds={caseManagementProjectIds}
              suiteManagementProjectIds={suiteManagementProjectIds}
              initialSearch={query ?? ""}
            />
          ) : (
            <section className="card case-library-empty-card">
              <div className="empty-state">
                <strong>请先选择完整的项目层级</strong>
                <p>请选择项目版本与测试阶段后查看用例。</p>
              </div>
            </section>
          )
        }
      />
    </div>
  );
}
