import { NextResponse } from "next/server";

import { authenticateRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request, { allowPasswordChangeRequired: true });
    return NextResponse.json({
      user: identity.user,
      systemPermissions: identity.systemPermissions,
      projectPermissions: identity.projectPermissions,
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
