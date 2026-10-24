import { NextResponse } from "next/server";
import { ddtSrTagMutationSchema } from "@autoforge/contracts";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { requestId, requireSameOrigin } from "@/lib/auth";
import { readSrTagMetadata, authorizeSrTagScope } from "@/lib/ddt-sr-tag-api";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const { scope, services } = await authorizeSrTagScope(request, url, "case.read");
    return NextResponse.json(await readSrTagMetadata(services.ddtSrTags, scope, url), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
export async function POST(request: Request) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const { scope, services, identity } = await authorizeSrTagScope(
      request,
      new URL(request.url),
      "case.manage",
    );
    const input = ddtSrTagMutationSchema.parse(await readJsonBody(request, 8192));
    const result = await services.ddtSrTags.mutate(scope, input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: `ddt_sr_tag.${input.operation}`,
      resourceType: "project_version",
      resourceId: scope.projectVersionId,
      projectId: scope.projectId,
      requestId: currentRequestId,
      details: input,
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
