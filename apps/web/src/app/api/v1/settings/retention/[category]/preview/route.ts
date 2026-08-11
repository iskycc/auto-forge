import { retentionCategorySchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ category: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const category = retentionCategorySchema.parse((await context.params).category);
    return NextResponse.json(
      await (await getPlatformServices()).platformOperations.previewRetention(identity, category),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
