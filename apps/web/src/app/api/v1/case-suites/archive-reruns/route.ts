import { NextResponse } from "next/server";
import {
  archiveRerunSuitesInputSchema,
  archiveRerunSuitesResultSchema,
} from "@autoforge/contracts";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import {
  authenticateRequest,
  authorizedProjectScope,
  requireSameOrigin,
  requestId,
} from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = archiveRerunSuitesInputSchema.parse(await readJsonBody(request, 4096));
    authorizedProjectScope(identity, "case_suite.manage", input.projectId);
    const services = await getPlatformServices();
    return NextResponse.json(
      archiveRerunSuitesResultSchema.parse(
        await services.caseSuites.archiveReruns(
          input.projectId,
          input.projectVersionId,
          identity.user.id,
          id,
        ),
      ),
    );
  } catch (error) {
    return apiErrorResponse(error, id);
  }
}
