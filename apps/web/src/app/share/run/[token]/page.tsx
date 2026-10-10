import type { Metadata } from "next";
import {
  InvalidPublicExecution,
  PublicExecutionDetail,
} from "@/components/public-execution-detail";
import { readPermanentShareToken } from "@/lib/permanent-share-token";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "执行详情公开访问" };

/** Read-only compatibility for URLs issued before the business-ID routes. */
export default async function LegacyPublicRunPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const services = await getPlatformServices();
  const batchId = readPermanentShareToken(services.config.masterKey, token, "run_batch");
  return batchId ? (
    <PublicExecutionDetail batchId={batchId} accessToken={token} />
  ) : (
    <InvalidPublicExecution />
  );
}
