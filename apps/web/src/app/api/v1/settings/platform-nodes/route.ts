import { platformNodeIdSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    await authorizeRequest(request, "settings.read", undefined);
    const services = await getPlatformServices();
    const cursor = new URL(request.url).searchParams.get("cursor");
    const page = services.platformNodes
      ? await services.platformNodes.list(cursor ? platformNodeIdSchema.parse(cursor) : undefined)
      : { items: [] };
    return NextResponse.json({ enabled: Boolean(services.platformNodes), ...page });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
