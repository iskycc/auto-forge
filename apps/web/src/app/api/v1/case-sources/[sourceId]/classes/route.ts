import { sourceDirectoryPartSchema } from "@autoforge/contracts";
import { authenticateRequest } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { readDirectoryApiPage } from "@/lib/read-directory-api-page";

export async function GET(request: Request, { params }: { params: Promise<{ sourceId: string }> }) {
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const { sourceId } = await params;
    const source = await services.caseSources.getSummary(
      sourceId,
      services.identityAccess.projectScope(identity, "case_source.read"),
    );
    return await readDirectoryApiPage({
      request,
      service: services.readModels,
      query: { kind: "source_directory", projectId: source.projectId, sourceId },
      schema: sourceDirectoryPartSchema,
      empty: [],
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
