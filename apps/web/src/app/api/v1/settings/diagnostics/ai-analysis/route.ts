import { authorizeRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request) {
  try {
    const identity = await authorizeRequest(request, "settings.read", undefined);
    const services = await getPlatformServices();
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    return Response.json(await services.aiAnalysis.runtime(identity, refresh), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (cause) {
    return apiErrorResponse(cause, requestId(request));
  }
}
