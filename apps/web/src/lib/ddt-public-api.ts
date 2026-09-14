import "server-only";

import { ddtCaseLookupSchema } from "@autoforge/contracts";
import type { DdtScope } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "./api-response";
import { requestId } from "./auth";
import { getPlatformServices } from "./services";

export type PublicDdtScopeContext = { params: Promise<DdtScope> };
export type PublicDdtCaseContext = { params: Promise<DdtScope & { caseId: string }> };

const publicReadHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Expose-Headers": "X-Response-Time",
  "X-Content-Type-Options": "nosniff",
};

export function publicDdtOptions(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { ...publicReadHeaders, "Access-Control-Allow-Headers": "Content-Type" },
  });
}

export async function readPublicDdtCase(
  request: Request,
  scope: DdtScope,
  caseId: string | null,
): Promise<NextResponse> {
  const startedAt = performance.now();
  const currentRequestId = requestId(request);
  let response: NextResponse;
  try {
    const input = ddtCaseLookupSchema.parse({ ...scope, caseId });
    const services = await getPlatformServices();
    // Scope comes exclusively from the path. The indexed repository lookup includes
    // all three IDs; no global fallback, session lookup or per-read statistics write.
    const payload = await services.ddtCases.getData(
      {
        projectId: input.projectId,
        projectVersionId: input.projectVersionId,
        testStageId: input.testStageId,
      },
      input.caseId,
    );
    response = NextResponse.json(payload);
  } catch (error) {
    response = await apiErrorResponse(error, currentRequestId);
  }
  for (const [name, value] of Object.entries(publicReadHeaders)) response.headers.set(name, value);
  response.headers.set("X-Response-Time", `${(performance.now() - startedAt).toFixed(2)}ms`);
  return response;
}
