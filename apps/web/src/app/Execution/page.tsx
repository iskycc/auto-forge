import type { Metadata } from "next";
import { z } from "zod";
import {
  InvalidPublicExecution,
  PublicExecutionDetail,
} from "@/components/public-execution-detail";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "执行详情公开访问" };
const querySchema = z.object({ BatchId: z.string().min(1).max(128) });

export default async function PublicExecutionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = querySchema.safeParse(await searchParams);
  return query.success ? (
    <PublicExecutionDetail batchId={query.data.BatchId} />
  ) : (
    <InvalidPublicExecution />
  );
}
