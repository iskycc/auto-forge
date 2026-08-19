import { Activity } from "lucide-react";

import { RunBatchPlanner } from "@/components/run-batch-planner";
import { getPlatformServices } from "@/lib/services";
import { hasPermissionInAnyScope, requirePageProjectScope } from "@/lib/auth";
import { projectIdsForPermission } from "@autoforge/domain";

export const dynamic = "force-dynamic";

export default async function RunBatchesPage() {
  const { identity, projectIds } = await requirePageProjectScope("run.read");
  const services = await getPlatformServices();
  const creatableProjectIds = projectIdsForPermission(identity, "run.create");
  const canCreateRuns = creatableProjectIds === undefined || creatableProjectIds.length > 0;
  const canReadRunners = hasPermissionInAnyScope(identity, "runner.read");
  const environmentProjectIds = hasPermissionInAnyScope(identity, "environment.read")
    ? services.identityAccess.projectScope(identity, "environment.read")
    : [];
  const [suites, runners, runnerGroups, environmentSummaries] = await Promise.all([
    services.caseSuites.list(200, projectIds),
    canReadRunners ? services.runnerControl.list(500) : Promise.resolve([]),
    canReadRunners ? services.runnerGroups.list() : Promise.resolve([]),
    environmentProjectIds?.length === 0
      ? Promise.resolve([])
      : services.executionEnvironments.list(environmentProjectIds),
  ]);
  const environments = await Promise.all(
    environmentSummaries.map((environment) =>
      services.executionEnvironments.get(environment.id, environmentProjectIds),
    ),
  );
  const creatableSuites =
    creatableProjectIds === undefined
      ? suites
      : suites.filter((suite) => creatableProjectIds.includes(suite.projectId));
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">Dynamic Scheduler</span>
          <h1>用例批跑</h1>
          <p>选择任务、执行机和环境，平台依据 Agent 实时资源快照动态生成执行分配。</p>
        </div>
        <span className="hero-icon violet">
          <Activity size={24} />
        </span>
      </section>
      <RunBatchPlanner
        canCreate={canCreateRuns}
        initialSuites={creatableSuites}
        initialRunners={runners}
        initialRunnerGroups={runnerGroups}
        initialEnvironments={environments}
        policy={services.runBatches.policy()}
      />
    </div>
  );
}
