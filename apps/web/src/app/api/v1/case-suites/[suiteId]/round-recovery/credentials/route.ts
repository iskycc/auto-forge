import {
  roundRecoveryCredentialSourcesPageSchema,
  roundRecoveryCredentialSourcesQuerySchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ suiteId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.manage");
    const { suiteId } = await context.params;
    const parameters = new URL(request.url).searchParams;
    const input = roundRecoveryCredentialSourcesQuerySchema.parse(Object.fromEntries(parameters));
    const page = await services.caseSuites.listRoundRecoveryCredentialSources(
      suiteId,
      input,
      projectIds,
    );
    return NextResponse.json(roundRecoveryCredentialSourcesPageSchema.parse(page), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
