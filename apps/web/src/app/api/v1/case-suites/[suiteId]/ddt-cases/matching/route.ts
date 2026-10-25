import {
  matchCaseSuiteDdtItemsInputSchema,
  caseSuiteDdtSelectionSchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

/** Read-only, bounded matching for the reviewed task; no member or version changes. */
export async function POST(request: Request, context: { params: Promise<{ suiteId: string }> }) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = matchCaseSuiteDdtItemsInputSchema.parse(await readJsonBody(request, 512 * 1_024));
    const { suiteId } = await context.params;
    const services = await getPlatformServices();
    const result = await services.caseSuites.matchDdtCases(
      suiteId,
      input,
      services.identityAccess.projectScope(identity, "case_suite.manage"),
    );
    return NextResponse.json(caseSuiteDdtSelectionSchema.parse(result), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
