import { ArrowLeft, BookOpenText } from "lucide-react";
import Link from "next/link";

import { CachedSuiteDirectory } from "@/components/cached-suite-directory";
import { suiteDirectoryManifestSchema } from "@autoforge/contracts";
import { CaseSuiteEditor } from "@/components/case-suite-editor";
import { CaseSuiteRevisionProvider } from "@/components/case-suite-revision";
import { CaseSuiteWebhookBindings } from "@/components/case-suite-webhook-bindings";
import { CaseSuiteSchedulePanel } from "@/components/case-suite-schedule-panel";
import { getPlatformServices } from "@/lib/services";
import { requirePageProjectScope } from "@/lib/auth";
import { hasPermission } from "@autoforge/domain";

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
  });
  const canManage = hasPermission(identity, "case_suite.manage", suite.projectId);
  const [runners, runnerGroups, projectStructure, webhookConfigurations, webhookIds, schedule] =
    await Promise.all([
      services.runnerControl.list(500),
      services.runnerGroups.list(),
      services.projectStructures.list(suite.projectId),
      services.webhooks.listConfigurations(suite.projectId),
      services.webhooks.listSuiteBindings(suiteId, projectIds),
      services.platformOperations.readSuiteSchedule(identity, suite),
    ]);
  const projectVersion = projectStructure.versions.find(
    (version) => version.id === suite.policy.projectVersionId,
  );
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <Link className="back-link" href="/case-suites">
            <ArrowLeft size={15} /> 用例任务
          </Link>
          <h1>{suite.name}</h1>
          <p>
            {suite.description || "未填写任务说明。"} · 项目版本
            {projectVersion ? `「${projectVersion.name}」` : "未关联"}
          </p>
        </div>
        {canManage ? (
          <Link className="button button-primary button-large" href="/cases">
            <BookOpenText size={17} /> 添加用例
          </Link>
        ) : null}
      </section>
      <CaseSuiteSchedulePanel
        key={`${suite.id}:${suite.revision}:${schedule?.revision ?? "none"}`}
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
      <CaseSuiteRevisionProvider initialRevision={suite.revision} key={suite.id}>
        <CaseSuiteEditor
          artifactsEnabled={services.configurationStore.read().limits.artifactCollectionEnabled}
          canManage={canManage}
          projectVersions={projectStructure.versions}
          runnerGroups={runnerGroups}
          runners={runners}
          suite={suite}
        />
        <CaseSuiteWebhookBindings
          canManage={canManage}
          configurations={webhookConfigurations}
          initialWebhookIds={webhookIds}
          suiteId={suiteId}
        />
        <CachedSuiteDirectory
          key={suite.id}
          canManage={canManage}
          suite={suite}
          snapshot={directory.status}
          manifest={
            directory.payload ? suiteDirectoryManifestSchema.parse(directory.payload) : null
          }
        />
      </CaseSuiteRevisionProvider>
    </div>
  );
}
