import { createCaseSuiteInputSchema } from "@autoforge/contracts";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await authorizeRequest(request, "case_suite.read");
    const url = new URL(request.url);
    const { limit } = querySchema.parse({ limit: url.searchParams.get("limit") ?? undefined });
    return NextResponse.json({ items: await (await getPlatformServices()).caseSuites.list(limit) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "case_suite.manage");
    const input = createCaseSuiteInputSchema.parse(await request.json());
    const services = await getPlatformServices();
    const suite = await services.caseSuites.create(input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.create",
      resourceType: "case_suite",
      resourceId: suite.id,
      requestId: currentRequestId,
    });
    return NextResponse.json(suite, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
