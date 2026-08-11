import { ArrowLeft, Clock3 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ExecutionBatchDetails } from "@/components/execution-batch-details";
import { requirePageProjectScope } from "@/lib/auth";
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

  return (
    <div className="page-stack">
      <Link className="back-link" href="/run-batches">
        <ArrowLeft size={16} /> 返回执行记录
      </Link>
      <section className="page-hero execution-detail-hero">
        <div>
          <span className="eyebrow">Execution Batch</span>
          <h1>{batch.suiteName}</h1>
          <p>
            批次 {batch.id} · 任务版本 v{batch.suiteVersion}
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
