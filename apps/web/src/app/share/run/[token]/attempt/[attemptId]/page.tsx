import type { Metadata } from "next";

import {
  InvalidAttemptLogShareView,
  SharedAttemptLogContent,
} from "@/components/shared-attempt-log-content";
import { currentIdentity } from "@/lib/auth";
import { readPermanentShareToken } from "@/lib/permanent-share-token";
import { getPlatformServices } from "@/lib/services";
import { sharedLogRerunAccess } from "@/lib/shared-attempt-log-access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "执行日志公开访问",
};

export default async function SharedRunAttemptLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; attemptId: string }>;
  searchParams: Promise<{ attempt?: string | string[] }>;
}) {
  const { token, attemptId: anchorAttemptId } = await params;
  const attemptParameter = (await searchParams).attempt;
  const selectedAttemptId =
    typeof attemptParameter === "string" && attemptParameter.length <= 128
      ? attemptParameter
      : undefined;
  const services = await getPlatformServices();
  const batchId = readPermanentShareToken(services.config.masterKey, token, "run_batch");
  if (!batchId) return <InvalidAttemptLogShareView />;
  const view = await services.attemptLogShares.getSharedAttemptLogForBatch(
    batchId,
    anchorAttemptId,
    selectedAttemptId,
  );
  if (!view) return <InvalidAttemptLogShareView />;
  const rerunAccess = await sharedLogRerunAccess(services, await currentIdentity(), view.attemptId);
  return (
    <SharedAttemptLogContent
      historyHref={`/share/run/${encodeURIComponent(token)}/attempt/${encodeURIComponent(anchorAttemptId)}`}
      rerunAccess={rerunAccess}
      timeZone={services.configurationStore.read().web.timeZone}
      view={view}
    />
  );
}
