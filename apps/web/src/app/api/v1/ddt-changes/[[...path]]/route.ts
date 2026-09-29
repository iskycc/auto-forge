import { NextResponse } from "next/server";
import { z } from "zod";
import { DomainError, hasPermission } from "@autoforge/domain";
import { submitDdtChangeRequestSchema, reviewDdtChangeRequestSchema } from "@autoforge/contracts";
import { authenticateRequest, requireSameOrigin, requestId } from "@/lib/auth";
import { authorizeDdtScope } from "@/lib/ddt-api";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path?: string[] }> };
const listSchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "withdrawn"]).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20),
  query: z.string().max(512, "CaseId 筛选最多支持 512 个字符。").default(""),
  mine: z.enum(["true", "false"]).default("true"),
});

async function handle(request: Request, context: Context) {
  const currentRequestId = requestId(request);
  try {
    if (request.method !== "GET") requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    if (identity.sessionId.startsWith("api-token:"))
      throw new DomainError("AUTH_FORBIDDEN", "调试变更提交和审核需要登录个人账号。");
    const url = new URL(request.url);
    const { scope, services } = await authorizeDdtScope(identity, "case.read", url);
    const canReview = hasPermission(identity, "case.manage", scope.projectId);
    const personalScope = { ...scope, ownerUserId: identity.user.id };
    const { path = [] } = await context.params;
    let result: unknown;
    let auditAction = "";
    if (request.method === "GET" && !path.length) {
      const query = listSchema.parse(Object.fromEntries(url.searchParams));
      result = await services.ddtChanges.list(scope, {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(!canReview || query.mine === "true" ? { ownerUserId: identity.user.id } : {}),
      });
    } else if (request.method === "GET" && path[0] === "candidates" && path.length <= 2) {
      services.identityAccess.authorize(identity, "run.create", scope.projectId);
      if (path[1])
        result = await services.ddtChanges.compare(
          personalScope,
          z.string().min(1).max(512).parse(path[1]),
        );
      else {
        const query = listSchema.parse(Object.fromEntries(url.searchParams));
        result = await services.ddtChanges.candidates(personalScope, {
          query: query.query,
          limit: query.limit,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        });
      }
    } else if (request.method === "GET" && path.length === 1) {
      result = await services.ddtChanges.get(
        scope,
        z.uuid().parse(path[0]),
        identity.user.id,
        canReview,
      );
    } else if (request.method === "POST" && !path.length) {
      services.identityAccess.authorize(identity, "run.create", scope.projectId);
      const input = submitDdtChangeRequestSchema.parse(await readJsonBody(request, 256 * 1024));
      result = await services.ddtChanges.submit(personalScope, input);
      auditAction = "ddt_change.submit";
    } else if (request.method === "POST" && path.length === 2 && path[1] === "review") {
      const input = reviewDdtChangeRequestSchema.parse(await readJsonBody(request, 32 * 1024));
      result = await services.ddtChanges.review(
        scope,
        z.uuid().parse(path[0]),
        identity.user.id,
        canReview,
        input,
      );
      if (input.action === "approve") await services.readModels.invalidate(scope.projectId);
      auditAction = `ddt_change.${input.action}`;
    }
    if (result === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "变更接口不存在。");
    if (auditAction)
      await services.identityAccess.recordAuthorizedOperation(identity, {
        action: auditAction,
        resourceType: "ddt_change_request",
        projectId: scope.projectId,
        requestId: currentRequestId,
        details: { ...scope, changeRequestId: (result as { id: string }).id },
      });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
export const GET = handle;
export const POST = handle;
