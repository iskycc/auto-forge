import { notFound } from "next/navigation";

import { PublicRunProgress } from "@/components/public-run-progress";
import { buildRunProgressFromOverview } from "@/lib/run-progress";
import { verifyRunProgressToken } from "@/lib/run-progress-token";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function RunProgressPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ access_token?: string }>;
}) {
  const [{ batchId }, query] = await Promise.all([params, searchParams]);
  const accessToken = query.access_token ?? "";
  const services = await getPlatformServices();
  if (
    !verifyRunProgressToken(services.config.masterKey, accessToken, batchId, services.clock.now())
  )
    notFound();
  const overview = await services.executionOverview(batchId).catch(() => null);
  if (!overview) notFound();
  return (
    <PublicRunProgress
      statisticsPending={!overview.statistics.generation}
      accessToken={accessToken}
      initial={buildRunProgressFromOverview(overview)}
    />
  );
}
