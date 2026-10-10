import { Result } from "antd";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { DomainError, hasPermission } from "@autoforge/domain";
import { redirect } from "next/navigation";

import { AuthenticatedRunRedirect } from "@/components/authenticated-run-redirect";
import { ExecutionBatchDetails } from "@/components/execution-batch-details";
import { RunBatchDetailHero } from "@/components/run-batch-detail-hero";
import type { RunnerDirectoryEntry } from "@/components/run-batch-rounds";
import { currentIdentity } from "@/lib/auth";
import { toExecutionBatchView } from "@/lib/execution-batch-view";
import { getPlatformServices } from "@/lib/services";
import { ColorModeToggle } from "@/components/color-mode-toggle";

export async function PublicExecutionDetail({
  batchId,
  accessToken,
}: {
  batchId: string;
  accessToken?: string;
}) {
  const services = await getPlatformServices();
  if (!accessToken && !(await services.publicExecutionAccess.isBatchPublic(batchId)))
    return <InvalidPublicExecution />;
  const overview = await services.executionOverview(batchId).catch((cause: unknown) => {
    if (cause instanceof DomainError && cause.code === "RUN_BATCH_NOT_FOUND") return null;
    throw cause;
  });
  if (!overview) return <InvalidPublicExecution />;
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
  const runnerDirectory: RunnerDirectoryEntry[] = (
    await services.runnerControl.listByIds(overview.participatingRunnerIds)
  ).map((runner) => ({
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
          {...(accessToken ? { accessToken } : {})}
          publicAccess={!accessToken}
          canCancelRuns={false}
          canCreateRuns={false}
          canRetryRuns={false}
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

export function InvalidPublicExecution() {
  return (
    <main
      className={cn(
        "shared-case-page shared-case-page-center",
        pageStyles["shared-case-page"],
        pageStyles["shared-case-page-center"],
      )}
    >
      <Result
        status="warning"
        title={<h1 className="m-0 text-xl">链接无效</h1>}
        subTitle={"该执行结果公开访问链接无效，或对应的执行记录已经被删除。"}
        extra={<ColorModeToggle />}
        className="w-full max-w-lg"
      />
    </main>
  );
}

const pageStyles = {
  "shared-case-invalid":
    "border border-solid border-border [background:color-mix(in_srgb,_var(--card)_96%,_transparent)] shadow-xs grid justify-items-center gap-2.5 w-[min(420px,_100%)] rounded-xl py-11 px-9 text-center [&_>_span]:grid [&_>_span]:w-14 [&_>_span]:h-14 [&_>_span]:place-items-center [&_>_span]:rounded-full [&_>_span]:bg-warning/10 [&_>_span]:text-warning [&_h1]:m-0 [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:text-sm [&_p]:leading-[1.7]",
  "shared-case-page":
    "min-h-screen p-12 bg-card [&_.is-enabled]:text-success [&_.is-muted]:text-muted-foreground max-[1101px]:p-8",
  "shared-case-page-center": "grid place-items-center",
  "shared-run-detail-page": "min-h-screen bg-background p-9 max-[1101px]:p-6",
  "shared-run-detail-shell": "mx-auto my-0 w-full max-w-[1600px]",
} as const;
