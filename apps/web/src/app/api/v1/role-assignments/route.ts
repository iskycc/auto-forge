import { NextResponse } from "next/server";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const id = requestId(request);
  try {
    requireSameOrigin(request);
    const actor = await authenticateRequest(request);
    const input = await readJsonBody(request, 16 * 1024);
    return NextResponse.json(
      await (await getPlatformServices()).identityAccess.assignRoleSelection(actor, input, id),
    );
  } catch (error) {
    return apiErrorResponse(error, id);
  }
}
