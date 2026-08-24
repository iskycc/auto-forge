import { ArrowLeft, Clock3 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ExecutionBatchDetails } from "@/components/execution-batch-details";
import type { RunnerDirectoryEntry } from "@/components/run-batch-rounds";
import { hasPermissionInAnyScope, requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function RunBatchDetailsPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { identity, projectIds } = await requirePageProjectScope("run.read");
  const { batchId } = await params;
  const services = await getPlatformServices();
  let batch;
  try {
    batch = await services.runBatches.get(batchId, projectIds);
  } catch {
    notFound();
  }
  const projectVersion = batch.policy?.projectVersionId
    ? (await services.projectStructures.list(batch.projectId)).versions.find(
        (version) => version.id === batch.policy?.projectVersionId,
      )
    : undefined;

  // 执行机目录把 UUID 映射为名称与实时资源快照；没有 runner.read 权限时
  // 传空目录，组件回落展示 UUID 短码，不泄露执行机清单。
  let runnerDirectory: RunnerDirectoryEntry[] = [];
  if (hasPermissionInAnyScope(identity, "runner.read")) {
    const runners = await services.runnerControl.list(500);
    runnerDirectory = runners.map((runner) => ({
      id: runner.id,
      name: runner.name,
      ...(runner.resourceSnapshot ? { resourceSnapshot: runner.resourceSnapshot } : {}),
    }));
  }

  return (
    <div className="page-stack">
      <Link className="back-link" href="/execution-records">
        <ArrowLeft size={16} /> 返回执行记录
      </Link>
      <section className="page-hero execution-detail-hero">
        <div>
          <span className="eyebrow">Execution Batch</span>
          <h1>{batch.suiteName}</h1>
          <p title={batch.id}>
            批次 #{batch.sequenceNumber} · 任务版本 v{batch.suiteVersion} · 项目版本
            {projectVersion ? `「${projectVersion.name}」` : "未关联"}
          </p>
        </div>
        <span className="hero-icon violet">
          <Clock3 size={24} />
        </span>
      </section>
      <ExecutionBatchDetails
        batch={batch}
        canCancelRuns={canAuthorize(() =>
          services.identityAccess.authorize(identity, "run.cancel", batch.projectId),
        )}
        canCreateRuns={canAuthorize(() =>
          services.identityAccess.authorize(identity, "run.create", batch.projectId),
        )}
        canReadLogs={canAuthorize(() =>
          services.identityAccess.authorize(identity, "log.read", batch.projectId),
        )}
        canReadArtifacts={canAuthorize(() =>
          services.identityAccess.authorize(identity, "artifact.read", batch.projectId),
        )}
        artifactsEnabled={services.configurationStore.read().limits.artifactCollectionEnabled}
        runnerDirectory={runnerDirectory}
      />
    </div>
  );
}

function canAuthorize(authorize: () => void): boolean {
  try {
    authorize();
    return true;
  } catch {
    return false;
  }
}
