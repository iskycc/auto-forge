import type { Metadata } from "next";
import { z } from "zod";
import { publicCaseLogPath } from "@autoforge/contracts";
import {
  InvalidAttemptLogShareView,
  SharedAttemptLogContent,
} from "@/components/shared-attempt-log-content";
import { currentIdentity } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { sharedLogAccess } from "@/lib/shared-attempt-log-access";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "用例执行日志" };
const querySchema = z.object({
  ExecutionId: z.string().min(1).max(128),
  AttemptId: z.string().min(1).max(128).optional(),
});

export default async function PublicCaseLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = querySchema.safeParse(await searchParams);
  if (!query.success) return <InvalidAttemptLogShareView />;
  const services = await getPlatformServices();
  const view = await services.publicExecutionAccess.readAttemptLog(
    query.data.ExecutionId,
    query.data.AttemptId,
  );
  if (!view) return <InvalidAttemptLogShareView />;
  const { rerunAccess, canCancelRuns } = await sharedLogAccess(
    services,
    await currentIdentity(),
    view.attemptId,
  );
  return (
    <SharedAttemptLogContent
      key={view.attemptId}
      canCancelRuns={canCancelRuns}
      historyHref={publicCaseLogPath(query.data.ExecutionId)}
      rerunAccess={rerunAccess}
      timeZone={services.configurationStore.read().web.timeZone}
      view={view}
    />
  );
}
