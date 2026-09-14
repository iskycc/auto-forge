import {
  publicDdtOptions,
  readPublicDdtCase,
  type PublicDdtCaseContext,
} from "@/lib/ddt-public-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: PublicDdtCaseContext) {
  const { caseId, ...scope } = await context.params;
  return readPublicDdtCase(request, scope, caseId);
}

export const OPTIONS = publicDdtOptions;
