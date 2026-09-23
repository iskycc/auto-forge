import { EmptyState } from "@/components/ui/empty-state";
import { Disclosure } from "@/components/ui/disclosure";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { DatabaseZap } from "lucide-react";

import { CachedCaseDirectory } from "@/components/cached-case-directory";
import { caseDirectoryManifestSchema, DIRECTORY_CHUNK_SIZE } from "@autoforge/contracts";
import { CaseManagementTabs } from "@/components/case-management-tabs";
import { DdtManagementWorkspace } from "@/components/ddt-management-workspace";
import { getPlatformServices } from "@/lib/services";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";
import { hasPermission, projectIdsForPermission } from "@autoforge/domain";

export const dynamic = "force-dynamic";

type CasesPageProps = {
  searchParams: Promise<{
    query?: string | string[];
    tab?: string | string[];
    targetSuiteId?: string | string[];
  }>;
};

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CasesPage({ searchParams }: CasesPageProps) {
  const { identity } = await requirePageProjectScope("case.read");
  const parameters = await searchParams;
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
          chunkSize: DIRECTORY_CHUNK_SIZE,
          tree: true,
          filter: { query: "", outcome: "all" },
        })
      : Promise.resolve(null),
    projectVersion
      ? services.caseSuites.list(200, effectiveProjectIds, projectVersion.id)
      : Promise.resolve([]),
  ]);
  const targetSuiteId = single(parameters.targetSuiteId);
  if (targetSuiteId && projectVersion && !suites.some((suite) => suite.id === targetSuiteId)) {
    // Direct task links must still select their target beyond the first list window.
    const target = await services.suites.getSummary(targetSuiteId, effectiveProjectIds);
    if (
      target &&
      target.policy.projectVersionId === projectVersion.id &&
      target.status === "active"
    )
      suites.unshift(target);
  }
  const directoryManifest = directoryProjection?.generation
    ? caseDirectoryManifestSchema.parse(directoryProjection.payload)
    : null;

  return (
    <div className={cn("page-stack", uiPatterns["page-stack"])}>
      <CaseManagementTabs
        canImport={canImport}
        ddtContent={
          projectId && projectVersion && testStage ? (
            <DdtManagementWorkspace
              versions={(structure?.versions ?? []).map((version) => ({
                id: version.id,
                name: version.name,
                stages: version.stages.map((stage) => ({ id: stage.id, name: stage.name })),
              }))}
              scopeLabels={{
                project: projects.find((project) => project.id === projectId)?.name ?? projectId,
                version: projectVersion.name,
                stage: testStage.name,
              }}
              canRun={hasPermission(identity, "run.create", projectId)}
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
            <Card
              as="section"
              className={cn(
                "card case-library-empty-card",
                uiPatterns["card"],
                pageStyles["case-library-empty-card"],
              )}
            >
              <EmptyState
                className={cn(
                  "empty-state case-library-empty",
                  uiPatterns["empty-state"],
                  pageStyles["case-library-empty"],
                )}
              >
                <span className={cn("empty-icon", uiPatterns["empty-icon"])}>
                  <DatabaseZap size={27} />
                </span>
                <strong>请先选择完整的项目层级</strong>
                <p>DDT 用例严格绑定项目、项目版本和测试阶段，配置完整后即可开始导入。</p>
              </EmptyState>
            </Card>
          )
        }
        initialTab={activeTab}
        scopeContent={
          <Card
            as="section"
            className={cn(
              "card case-scope-toolbar",
              uiPatterns["card"],
              pageStyles["case-scope-toolbar"],
            )}
            aria-label="用例范围"
          >
            <Disclosure
              header={<>范围说明</>}
              className={cn("case-scope-heading", pageStyles["case-scope-heading"])}
            >
              <span>由顶栏项目层级统一控制；展开目录时按需加载，搜索覆盖当前范围的所有用例。</span>
            </Disclosure>
            <div
              className={cn("case-scope-current", pageStyles["case-scope-current"])}
              aria-label="当前用例层级"
            >
              <span>
                <small>项目版本</small>
                <strong>{projectVersion?.name ?? "尚未配置"}</strong>
              </span>
              <span>
                <small>测试阶段</small>
                <strong>{testStage?.name ?? "尚未配置"}</strong>
              </span>
            </div>
          </Card>
        }
        testngContent={
          directoryProjection ? (
            <CachedCaseDirectory
              projectId={projectId!}
              key={directoryProjection.id}
              snapshot={directoryProjection.status}
              manifest={directoryManifest}
              canImport={canImport}
              suites={suites}
              caseManagementProjectIds={caseManagementProjectIds}
              suiteManagementProjectIds={suiteManagementProjectIds}
            />
          ) : (
            <Card
              as="section"
              className={cn(
                "card case-library-empty-card",
                uiPatterns["card"],
                pageStyles["case-library-empty-card"],
              )}
            >
              <EmptyState className={cn("empty-state", uiPatterns["empty-state"])}>
                <strong>请先选择完整的项目层级</strong>
                <p>请选择项目版本与测试阶段后查看用例。</p>
              </EmptyState>
            </Card>
          )
        }
      />
    </div>
  );
}

const pageStyles = {
  "case-library-empty":
    "w-[min(100%,_560px)] min-h-[320px] justify-self-center gap-1 py-10 px-6 [&_.button]:mt-4.5",
  "case-library-empty-card": "grid min-h-[360px] overflow-hidden",
  "case-scope-current":
    "[&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:gap-2 [&_>_span]:border-l [&_>_span]:border-solid [&_>_span]:border-border [&_>_span]:pl-3.5 [&_>_span]:items-center [&_small]:text-muted-foreground [&_small]:shrink-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:[overflow-wrap:anywhere] grid min-w-0 grid-cols-[repeat(2,_minmax(140px,_1fr))] justify-self-end gap-2.5 max-[1181px]:w-full max-[1181px]:justify-self-stretch",
  "case-scope-heading":
    "grid gap-[3px] [&_span]:text-muted-foreground [&_span]:text-xs [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:text-muted-foreground [&_.ui-disclosure-label]:text-sm",
  "case-scope-toolbar":
    "grid grid-cols-[minmax(0,_1fr)_minmax(0,_2fr)] items-center gap-3 py-4 px-4.5 py-2 max-[1181px]:grid-cols-[1fr]",
} as const;
