import { createCaseSuiteInputSchema } from "@autoforge/contracts";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authenticateRequest,
  authorizedProjectScope,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";

const querySchema = z.object({
  projectId: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const url = new URL(request.url);
    const { limit, projectId } = querySchema.parse({
      projectId: url.searchParams.get("projectId") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const projectIds = authorizedProjectScope(identity, "case_suite.read", projectId);
    return NextResponse.json({
      items: await (await getPlatformServices()).caseSuites.list(limit, projectIds),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = createCaseSuiteInputSchema.parse(await request.json());
    const services = await getPlatformServices();
    const projectScope = authorizedProjectScope(identity, "case_suite.manage", input.projectId);
    const projectId = input.projectId || projectScope?.at(0) || DEFAULT_PROJECT_ID;
    const suite = await services.caseSuites.create({ ...input, projectId }, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.create",
      resourceType: "case_suite",
      resourceId: suite.id,
      projectId: suite.projectId,
      requestId: currentRequestId,
    });
    return NextResponse.json(suite, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
