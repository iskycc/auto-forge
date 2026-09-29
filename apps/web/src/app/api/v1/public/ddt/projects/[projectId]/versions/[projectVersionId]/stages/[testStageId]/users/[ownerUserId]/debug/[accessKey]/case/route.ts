import type { DdtScope } from "@autoforge/domain";
import { publicDdtOptions, readPublicDdtCase } from "@/lib/ddt-public-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<DdtScope & { ownerUserId: string; accessKey: string }> },
) {
  const { ownerUserId, accessKey, ...scope } = await context.params;
  return readPublicDdtCase(request, scope, new URL(request.url).searchParams.get("caseId"), {
    ownerUserId,
    accessKey,
  });
}
export const OPTIONS = publicDdtOptions;
