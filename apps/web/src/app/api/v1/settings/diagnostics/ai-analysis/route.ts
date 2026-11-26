import { authorizeRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request) {
  try {
    const identity = await authorizeRequest(request, "settings.read", undefined);
    const services = await getPlatformServices();
    return Response.json(await services.aiAnalysis.runtime(identity), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (cause) {
    return apiErrorResponse(cause, requestId(request));
  }
}
