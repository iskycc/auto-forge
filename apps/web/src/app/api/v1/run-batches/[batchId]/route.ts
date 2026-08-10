import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";

type Context = { params: Promise<{ batchId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { batchId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    return NextResponse.json(await services.runBatches.get(batchId, projectIds));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
