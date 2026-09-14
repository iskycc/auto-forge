import {
  publicDdtOptions,
  readPublicDdtCase,
  type PublicDdtScopeContext,
} from "@/lib/ddt-public-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: PublicDdtScopeContext) {
  return readPublicDdtCase(
    request,
    await context.params,
    new URL(request.url).searchParams.get("caseId"),
  );
}

export const OPTIONS = publicDdtOptions;
