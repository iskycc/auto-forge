import { suiteDirectoryPartSchema, DIRECTORY_CHUNK_SIZE } from "@autoforge/contracts";
import { authenticateRequest } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { readDirectoryApiPage } from "@/lib/read-directory-api-page";

export async function GET(request: Request, { params }: { params: Promise<{ suiteId: string }> }) {
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const { suiteId } = await params;
    const suite = await services.caseSuites.getSummary(
      suiteId,
      services.identityAccess.projectScope(identity, "case_suite.read"),
    );
    return await readDirectoryApiPage({
      request,
      service: services.readModels,
      query: {
        kind: "suite_directory",
        projectId: suite.projectId,
        suiteId,
        chunkSize: DIRECTORY_CHUNK_SIZE,
        search: "",
      },
      schema: suiteDirectoryPartSchema,
      empty: { items: [], ddtItems: [] },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
