import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { ArrowLeft, BookOpenText } from "lucide-react";
import Link from "next/link";
import { LinkButton } from "@/components/ui/link-button";

import { CachedSuiteDirectory } from "@/components/cached-suite-directory";
import { suiteDirectoryManifestSchema, DIRECTORY_CHUNK_SIZE } from "@autoforge/contracts";
import { CaseSuiteEditor } from "@/components/case-suite-editor";
import { CaseSuiteRevisionProvider } from "@/components/case-suite-revision";
import { CaseSuiteWebhookBindings } from "@/components/case-suite-webhook-bindings";
import { CaseSuiteSchedulePanel } from "@/components/case-suite-schedule-panel";
import { getPlatformServices } from "@/lib/services";
import { requirePageProjectScope } from "@/lib/auth";
import { hasPermission } from "@autoforge/domain";
import { selectedProjectHierarchy } from "@/lib/selected-project";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ suiteId: string }> };

export default async function CaseSuitePage({ params }: Props) {
  const { identity, projectIds } = await requirePageProjectScope("case_suite.read");
  const { suiteId } = await params;
  const services = await getPlatformServices();
  const suite = await services.caseSuites.getSummary(suiteId, projectIds);
  const directory = await services.readModels.read({
    kind: "suite_directory",
    projectId: suite.projectId,
    suiteId,
    chunkSize: DIRECTORY_CHUNK_SIZE,
    tree: true,
    search: "",
  });
  const canManage = hasPermission(identity, "case_suite.manage", suite.projectId);
  const [
    runners,
    runnerGroups,
    projectStructure,
    webhookConfigurations,
    webhookIds,
    schedule,
    projects,
  ] = await Promise.all([
    services.runnerControl.list(500),
    services.runnerGroups.list(),
    services.projectStructures.list(suite.projectId),
    services.webhooks.listConfigurations(suite.projectId),
    services.webhooks.listSuiteBindings(suiteId, projectIds),
    services.platformOperations.readSuiteSchedule(identity, suite),
    services.identities.listProjects([suite.projectId]),
  ]);
  const hierarchy = await selectedProjectHierarchy(projectStructure);
  const projectVersion = projectStructure.versions.find(
    (version) => version.id === suite.policy.projectVersionId,
  );
  return (
    <div
      className={cn(
        "page-stack suite-detail-page",
        uiPatterns["page-stack"],
        pageStyles["suite-detail-page"],
      )}
    >
      <section className={cn("page-hero", uiPatterns["page-hero"])}>
        <div>
          <Link className={cn("back-link", pageStyles["back-link"])} href="/case-suites">
            <ArrowLeft size={15} /> 用例任务
          </Link>
          <h1>{suite.name}</h1>
          <p>
            {suite.description || "未填写任务说明。"} · 项目版本
            {projectVersion ? `「${projectVersion.name}」` : "未关联"}
          </p>
        </div>
        {canManage ? (
          <div className={cn("button-row", uiPatterns["button-row"])}>
            <LinkButton
              className={cn(
                "button button-secondary",
                uiPatterns["button"],
                uiPatterns["button-secondary"],
              )}
              href={`/cases?targetSuiteId=${encodeURIComponent(suite.id)}`}
            >
              <BookOpenText size={17} /> 添加普通用例
            </LinkButton>
            <LinkButton
              variant="primary"
              className={cn(
                "button button-primary",
                uiPatterns["button"],
                uiPatterns["button-primary"],
              )}
              href={`/cases?tab=ddt&ddtView=cases&targetSuiteId=${encodeURIComponent(suite.id)}`}
            >
              <BookOpenText size={17} /> 添加 DDT 用例
            </LinkButton>
          </div>
        ) : null}
      </section>
      <nav className={cn("section-links", pageStyles["section-links"])} aria-label="任务分区">
        <a href="#suite-members">用例列表</a>
        <a href="#suite-settings">任务配置</a>
        <a href="#suite-schedule">执行计划</a>
        <a href="#suite-notifications">完成通知</a>
      </nav>
      <CaseSuiteRevisionProvider initialRevision={suite.revision} key={suite.id}>
        <div id="suite-members">
          <CachedSuiteDirectory
            key={suite.id}
            canManage={canManage}
            suite={suite}
            snapshot={directory.status}
            manifest={
              directory.payload ? suiteDirectoryManifestSchema.parse(directory.payload) : null
            }
          />
        </div>
        <div id="suite-settings">
          <CaseSuiteEditor
            projectName={projects.find((project) => project.id === suite.projectId)?.name ?? ""}
            selectedTestStageId={hierarchy.testStageId}
            artifactsEnabled={services.configurationStore.read().limits.artifactCollectionEnabled}
            canManage={canManage}
            projectVersions={projectStructure.versions}
            runnerGroups={runnerGroups}
            runners={runners}
            suite={suite}
          />
        </div>
        <div id="suite-schedule">
          <CaseSuiteSchedulePanel
            key={suite.id}
            canManage={canManage}
            canReadExecutions={hasPermission(identity, "run.read", suite.projectId)}
            initialSchedule={schedule}
            suite={{
              id: suite.id,
              name: suite.name,
              projectId: suite.projectId,
              projectVersionId: suite.policy.projectVersionId ?? "",
              enabled: suite.enabled,
              archived: suite.status === "archived",
            }}
          />
        </div>
        <div id="suite-notifications">
          <CaseSuiteWebhookBindings
            canManage={canManage}
            configurations={webhookConfigurations}
            initialWebhookIds={webhookIds}
            suiteId={suiteId}
          />
        </div>
      </CaseSuiteRevisionProvider>
    </div>
  );
}

const pageStyles = {
  "back-link":
    "text-muted-foreground font-semibold inline-flex items-center gap-1.5 mb-[5px] text-sm w-fit [&:hover]:[text-decoration:underline]",
  "section-links":
    "flex items-center justify-start flex-wrap gap-3 text-muted-foreground text-sm border-b border-solid border-border pb-3 [&_a]:py-2 [&_a]:px-3 [&_a]:rounded-lg [&_a]:bg-card",
  "suite-detail-page": '[&_[id^="suite-"]]:[scroll-margin-top:calc(20px_*_5)]',
} as const;
