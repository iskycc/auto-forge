import {
  storageObjectDirectoryPageSchema,
  storageObjectDirectoryQuerySchema,
} from "@autoforge/contracts";
import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const currentRequestId = requestId(request);
  try {
    await authorizeRequest(request, "settings.read", undefined);
    const input = storageObjectDirectoryQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const services = await getPlatformServices();
    return Response.json(
      storageObjectDirectoryPageSchema.parse(
        await services.storageInventory.listObjectDirectory(input),
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
