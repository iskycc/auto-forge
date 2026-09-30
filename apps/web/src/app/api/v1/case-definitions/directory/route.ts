import { NextResponse } from "next/server";
import { DIRECTORY_CHUNK_SIZE, ddtScopeSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { authenticateRequest, authorizedProjectScope } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

/** Open the existing scoped snapshot without reading any unopened branches. */
export async function GET(request: Request) {
  try {
    const identity = await authenticateRequest(request);
    const scope = ddtScopeSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    authorizedProjectScope(identity, "case.read", scope.projectId);
    const services = await getPlatformServices();
    const structure = await services.projectStructures.list(scope.projectId);
    const version = structure.versions.find((item) => item.id === scope.projectVersionId);
    if (!version?.stages.some((stage) => stage.id === scope.testStageId)) {
      throw new DomainError("CASE_SCOPE_NOT_FOUND", "指定的项目版本或测试阶段不存在。");
    }
    const projection = await services.readModels.read({
      ...scope,
      kind: "case_directory",
      chunkSize: DIRECTORY_CHUNK_SIZE,
      tree: true,
      filter: { query: "", outcome: "all" },
    });
    return NextResponse.json(
      { status: projection.status },
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
