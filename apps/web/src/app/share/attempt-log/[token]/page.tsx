import type { Metadata } from "next";

import {
  InvalidAttemptLogShareView,
  SharedAttemptLogContent,
} from "@/components/shared-attempt-log-content";
import { currentIdentity } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { sharedLogAccess } from "@/lib/shared-attempt-log-access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "执行日志公开访问",
};

export default async function SharedAttemptLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ attempt?: string | string[] }>;
}) {
  const { token } = await params;
  const attemptParameter = (await searchParams).attempt;
  const selectedAttemptId =
    typeof attemptParameter === "string" && attemptParameter.length <= 128
      ? attemptParameter
      : undefined;
  const services = await getPlatformServices();
  const view = await services.attemptLogShares.getSharedAttemptLog(token, selectedAttemptId);
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
      historyHref={`/share/attempt-log/${encodeURIComponent(token)}`}
      rerunAccess={rerunAccess}
      timeZone={services.configurationStore.read().web.timeZone}
      view={view}
    />
  );
}
