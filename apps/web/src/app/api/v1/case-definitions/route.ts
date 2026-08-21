import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { deleteCaseDefinitionsInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authenticateRequest,
  authorizedProjectScope,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";

export const runtime = "nodejs";

const querySchema = z.object({
  projectId: z.string().min(1).max(128).optional(),
  projectVersionId: z.string().min(1).max(128).optional(),
  testStageId: z.string().min(1).max(128).optional(),
  query: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const url = new URL(request.url);
    const input = querySchema.parse({
      query: url.searchParams.get("query") ?? undefined,
      projectId: url.searchParams.get("projectId") ?? undefined,
      projectVersionId: url.searchParams.get("projectVersionId") ?? undefined,
      testStageId: url.searchParams.get("testStageId") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const projectIds = authorizedProjectScope(identity, "case.read", input.projectId);
    const page = await (
      await getPlatformServices()
    ).catalog.listCases({
      ...(projectIds ? { projectIds } : {}),
      ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
      ...(input.testStageId ? { testStageId: input.testStageId } : {}),
      scopedOnly: true,
      limit: input.limit,
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    return NextResponse.json(page);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = deleteCaseDefinitionsInputSchema.parse(
      await readJsonBody(request, 16 * 1_024 * 1_024),
    );
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case.manage");
    const deleted = await services.caseDefinitions.deleteMany(input.caseDefinitionIds, projectIds);
    const countsByProject = new Map<string, number>();
    for (const definition of deleted) {
      countsByProject.set(
        definition.projectId,
        (countsByProject.get(definition.projectId) ?? 0) + 1,
      );
    }
    for (const [projectId, caseCount] of countsByProject) {
      await services.identityAccess.recordAuthorizedOperation(identity, {
        action: "case_definition.delete_many",
        resourceType: "case_definition",
        projectId,
        requestId: currentRequestId,
        details: { caseCount },
      });
    }
    return NextResponse.json({ deletedCount: deleted.length });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
