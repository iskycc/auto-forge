import { authorizeRequest, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { OpenAiCompatibleGateway } from "../../../../../../../server/ai-model-gateway";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await authorizeRequest(request, "settings.manage", undefined);
    return Response.json(
      await (
        await getPlatformServices()
      ).aiAnalysis.check(
        await readJsonBody(request, 32768),
        new OpenAiCompatibleGateway(),
        request.signal,
      ),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
