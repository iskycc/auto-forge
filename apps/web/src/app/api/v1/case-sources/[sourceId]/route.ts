import {
  deleteCaseSourceInputSchema,
  updateCaseSourceLifecycleInputSchema,
} from "@autoforge/contracts";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";

type Context = { params: Promise<{ sourceId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    await authorizeRequest(request, "case_source.read");
    const { sourceId } = await context.params;
    return NextResponse.json(await (await getPlatformServices()).caseSources.get(sourceId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "case_source.manage");
    const input = updateCaseSourceLifecycleInputSchema.parse(await readJsonBody(request, 16_384));
    const { sourceId } = await context.params;
    const services = await getPlatformServices();
    const source = await services.caseSources.updateLifecycle(sourceId, input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: input.archived ? "case_source.archive" : "case_source.restore",
      resourceType: "case_source",
      resourceId: sourceId,
      requestId: currentRequestId,
    });
    return NextResponse.json(source);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "case_source.manage");
    const input = deleteCaseSourceInputSchema.parse(await readJsonBody(request, 16_384));
    const { sourceId } = await context.params;
    const services = await getPlatformServices();
    const source = await services.caseSources.deleteSource(sourceId, input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_source.delete",
      resourceType: "case_source",
      resourceId: sourceId,
      requestId: currentRequestId,
    });
    return NextResponse.json(source);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
