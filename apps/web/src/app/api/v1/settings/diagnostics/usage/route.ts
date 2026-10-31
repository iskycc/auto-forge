import { NextResponse } from "next/server";
import { infrastructureDependencySchema } from "@autoforge/contracts";
import { authorizeRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request) {
  const currentRequestId = requestId(request);
  try {
    await authorizeRequest(request, "settings.read", undefined);
    const url = new URL(request.url);
    const dependency = infrastructureDependencySchema.parse(url.searchParams.get("dependency"));
    const services = await getPlatformServices();
    return NextResponse.json(
      await services.infrastructureUsage.read(dependency, url.searchParams.get("refresh") === "1"),
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (cause) {
    return apiErrorResponse(cause, currentRequestId);
  }
}
