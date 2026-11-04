import { authorizeRequest, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request) {
  try {
    await authorizeRequest(request, "settings.read", undefined);
    return Response.json(await (await getPlatformServices()).aiAnalysis.configuration(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    await authorizeRequest(request, "settings.manage", undefined);
    return Response.json(
      await (await getPlatformServices()).aiAnalysis.configure(await readJsonBody(request, 32768)),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
