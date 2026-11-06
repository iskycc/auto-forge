import { runtimeAssetUsageQuerySchema, runtimeAssetUsagePageSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    await authorizeRequest(request, "settings.read", undefined);
    const parameters = new URL(request.url).searchParams;
    const input = runtimeAssetUsageQuerySchema.parse({
      runtimeAssetId: parameters.get("runtimeAssetId") ?? undefined,
      cursor: parameters.get("cursor") ?? undefined,
      limit: parameters.get("limit") ?? undefined,
    });
    const services = await getPlatformServices();
    return NextResponse.json(
      runtimeAssetUsagePageSchema.parse(
        await services.projectStructures.listRuntimeAssetUsagesPage(input),
      ),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
