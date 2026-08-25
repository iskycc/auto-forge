import { Link2Off } from "lucide-react";
import type { Metadata } from "next";

import { ExecutionBatchDetails } from "@/components/execution-batch-details";
import { RunBatchDetailHero } from "@/components/run-batch-detail-hero";
import type { RunnerDirectoryEntry } from "@/components/run-batch-rounds";
import { toExecutionBatchView } from "@/lib/execution-batch-view";
import { readPermanentShareToken } from "@/lib/permanent-share-token";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "执行详情永久分享",
};

export default async function SharedRunPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const services = await getPlatformServices();
  const batchId = readPermanentShareToken(services.config.masterKey, token, "run_batch");
  if (!batchId) return <InvalidRunShare />;
  const batch = await services.runBatches.get(batchId).catch(() => null);
  if (!batch) return <InvalidRunShare />;
  const projectVersion = batch.policy?.projectVersionId
    ? (await services.projectStructures.list(batch.projectId)).versions.find(
        (version) => version.id === batch.policy?.projectVersionId,
      )
    : undefined;
  const participatingRunnerIds = new Set([
    ...batch.runs.flatMap((run) => (run.assignedRunnerId ? [run.assignedRunnerId] : [])),
    ...batch.attempts.map((attempt) => attempt.runnerId),
  ]);
  const runnerDirectory: RunnerDirectoryEntry[] = (await services.runnerControl.list(500))
    .filter((runner) => participatingRunnerIds.has(runner.id))
    .map((runner) => ({
      id: runner.id,
      name: runner.name,
      ...(runner.resourceSnapshot ? { resourceSnapshot: runner.resourceSnapshot } : {}),
    }));

  return (
    <main className="shared-run-detail-page">
      <div className="page-stack shared-run-detail-shell">
        <RunBatchDetailHero
          batchId={batch.id}
          sequenceNumber={batch.sequenceNumber}
          suiteName={batch.suiteName}
          suiteVersion={batch.suiteVersion}
          {...(projectVersion ? { projectVersionName: projectVersion.name } : {})}
          shared
        />
        <ExecutionBatchDetails
          batch={toExecutionBatchView(batch)}
          canCancelRuns={false}
          canCreateRuns={false}
          canReadLogs={false}
          canReadAttemptEvents={false}
          canReadArtifacts={false}
          artifactsEnabled={false}
          runnerDirectory={runnerDirectory}
        />
      </div>
    </main>
  );
}

function InvalidRunShare() {
  return (
    <main className="shared-case-page shared-case-page-center">
      <section className="shared-case-invalid" aria-label="执行结果永久分享链接不可用">
        <span aria-hidden="true">
          <Link2Off size={30} strokeWidth={1.8} />
        </span>
        <h1>链接无效</h1>
        <p>该执行结果永久分享链接无效，或对应的执行记录已经被删除。</p>
      </section>
    </main>
  );
}
