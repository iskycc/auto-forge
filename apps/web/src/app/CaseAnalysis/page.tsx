import type { Metadata } from "next";
import { Result } from "antd";
import { z } from "zod";
import { isDomainError } from "@autoforge/domain";
import { currentIdentity } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { PublicFailureAnalysis } from "@/components/public-failure-analysis";
import { ColorModeToggle } from "@/components/color-mode-toggle";
import {
  analysisSheetQuery,
  analysisSheetSearchParameters,
} from "@/lib/failure-analysis-sheet-query";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "公开用例分析",
  robots: { index: false, follow: false },
};
export default async function PublicCaseAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const query = z.object({ BatchId: z.string().min(1).max(200) }).safeParse(parameters);
  if (!query.success) return <Unavailable />;
  const services = await getPlatformServices();
  const scope = await services.analysisPublications
    .requirePublic(query.data.BatchId)
    .catch((cause: unknown) => {
      if (isDomainError(cause) && cause.code === "FAILURE_ANALYSIS_PUBLIC_NOT_FOUND") return null;
      throw cause;
    });
  if (!scope) return <Unavailable />;
  const identity = await currentIdentity();
  const initialPage = await services.analysisSheet.read(
    scope,
    analysisSheetQuery(analysisSheetSearchParameters(parameters), identity?.user.id ?? null),
    identity?.user.id,
  );
  return (
    <PublicFailureAnalysis
      batchId={scope.batchId}
      suiteName={scope.suiteName}
      sequenceNumber={scope.sequenceNumber}
      archived={Boolean(scope.archivedAt)}
      publisher={scope.publisher!.username}
      initialPage={initialPage}
      currentUser={
        identity
          ? {
              id: identity.user.id,
              username: identity.user.username,
              forcePasswordChange: identity.user.forcePasswordChange,
            }
          : null
      }
    />
  );
}
function Unavailable() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-8">
      <Result
        status="warning"
        title="公开分析链接不可用"
        subTitle="分析任务可能已关闭、链接已撤销或分享人已停用，请联系任务维护人。"
        extra={<ColorModeToggle />}
      />
    </main>
  );
}
