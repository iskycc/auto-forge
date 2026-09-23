import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { hasPermission } from "@autoforge/domain";
import { Link2Off } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthenticatedRunRedirect } from "@/components/authenticated-run-redirect";
import { ExecutionBatchDetails } from "@/components/execution-batch-details";
import { RunBatchDetailHero } from "@/components/run-batch-detail-hero";
import type { RunnerDirectoryEntry } from "@/components/run-batch-rounds";
import { currentIdentity } from "@/lib/auth";
import { toExecutionBatchView } from "@/lib/execution-batch-view";
import { readPermanentShareToken } from "@/lib/permanent-share-token";
import { getPlatformServices } from "@/lib/services";
import { ColorModeToggle } from "@/components/color-mode-toggle";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "执行详情永久分享",
};

export default async function SharedRunPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const services = await getPlatformServices();
  const batchId = readPermanentShareToken(services.config.masterKey, token, "run_batch");
  if (!batchId) return <InvalidRunShare />;
  const overview = await services.executionOverview(batchId).catch(() => null);
  if (!overview) return <InvalidRunShare />;
  const batch = overview.batch;
  const identity = await currentIdentity();
  if (identity && hasPermission(identity, "run.read", batch.projectId)) {
    redirect(`/run-batches/${encodeURIComponent(batchId)}`);
  }
  const projectVersion = batch.policy?.projectVersionId
    ? (await services.projectStructures.list(batch.projectId)).versions.find(
        (version) => version.id === batch.policy?.projectVersionId,
      )
    : undefined;
  const participatingRunnerIds = new Set(overview.participatingRunnerIds);
  const runnerDirectory: RunnerDirectoryEntry[] = (await services.runnerControl.list(500))
    .filter((runner) => participatingRunnerIds.has(runner.id))
    .map((runner) => ({
      id: runner.id,
      name: runner.name,
      ...(runner.resourceSnapshot ? { resourceSnapshot: runner.resourceSnapshot } : {}),
    }));

  return (
    <main className={cn("shared-run-detail-page", pageStyles["shared-run-detail-page"])}>
      {!identity && <AuthenticatedRunRedirect batchId={batchId} />}
      <div
        className={cn(
          "page-stack shared-run-detail-shell",
          uiPatterns["page-stack"],
          pageStyles["shared-run-detail-shell"],
        )}
      >
        <RunBatchDetailHero
          batchId={batch.id}
          sequenceNumber={batch.sequenceNumber}
          suiteName={batch.suiteName}
          suiteVersion={batch.suiteVersion}
          {...(projectVersion ? { projectVersionName: projectVersion.name } : {})}
          shared
        />
        <ExecutionBatchDetails
          batch={toExecutionBatchView(overview)}
          accessToken={token}
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
    <main
      className={cn(
        "shared-case-page shared-case-page-center",
        pageStyles["shared-case-page"],
        pageStyles["shared-case-page-center"],
      )}
    >
      <section
        className={cn("shared-case-invalid", pageStyles["shared-case-invalid"])}
        aria-label="执行结果永久分享链接不可用"
      >
        <span aria-hidden="true">
          <Link2Off size={30} strokeWidth={1.8} />
        </span>
        <h1>链接无效</h1>
        <ColorModeToggle />
        <p>该执行结果永久分享链接无效，或对应的执行记录已经被删除。</p>
      </section>
    </main>
  );
}

const pageStyles = {
  "shared-case-invalid":
    "border border-solid border-border [background:color-mix(in_srgb,_var(--card)_96%,_transparent)] shadow-xs grid justify-items-center gap-2.5 w-[min(420px,_100%)] rounded-xl py-11 px-9 text-center [&_>_span]:grid [&_>_span]:w-14 [&_>_span]:h-14 [&_>_span]:place-items-center [&_>_span]:rounded-full [&_>_span]:bg-warning/10 [&_>_span]:text-warning [&_h1]:m-0 [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:text-sm [&_p]:leading-[1.7]",
  "shared-case-page":
    "min-h-screen p-12 bg-card [&_.is-enabled]:text-success [&_.is-muted]:text-muted-foreground max-[1101px]:p-8",
  "shared-case-page-center": "grid place-items-center",
  "shared-run-detail-page":
    "min-h-screen p-9 bg-card [&_.execution-case-table]:w-full [&_.execution-case-table]:min-w-0 [&_.execution-case-table_col:first-child]:w-[23%] [&_.execution-case-table_col:nth-last-child(4)]:w-[18%] [&_.execution-case-table_col:nth-last-child(3)]:w-[20%] [&_.execution-case-table_.case-column-duration]:w-[5rem] [&_.execution-case-table_.case-column-actions]:w-40 [&_.round-row-actions]:flex-nowrap [&_.round-row-actions_.compact-button]:gap-[3px] [&_.round-row-actions_.compact-button]:px-1 [&_.round-row-actions_.compact-button]:text-xs [&_.execution-case-table_th:nth-last-child(2)]:[overflow-wrap:normal] [&_.execution-case-table_th:nth-last-child(2)]:whitespace-nowrap [&_.execution-case-table_td:nth-last-child(2)]:[overflow-wrap:normal] [&_.execution-case-table_td:nth-last-child(2)]:whitespace-nowrap max-[1101px]:p-6",
  "shared-run-detail-shell": "w-[min(1600px,_100%)] my-0 mx-auto",
} as const;
