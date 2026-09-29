import { NextResponse } from "next/server";
import { z } from "zod";
import {
  confirmDdtImportInputSchema,
  resolveDdtImportColumnsInputSchema,
  ddtCaseDataSchema,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { apiErrorResponse, readDdtUploads, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { authorizeDdtScope } from "@/lib/ddt-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const caseIdSchema = z.string().trim().min(1).max(512);
const updateSchema = z
  .object({ data: ddtCaseDataSchema, revision: z.number().int().positive() })
  .strict();

async function handle(request: Request, context: Context) {
  const currentRequestId = requestId(request);
  try {
    if (request.method !== "GET") requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    if (identity.sessionId.startsWith("api-token:"))
      throw new DomainError("DDT_DEBUG_USER_REQUIRED", "个人调试需要登录用户账号。");
    const url = new URL(request.url);
    const { scope, services } = await authorizeDdtScope(identity, "run.create", url);
    services.identityAccess.authorize(identity, "case.read", scope.projectId);
    const personalScope = { ...scope, ownerUserId: identity.user.id };
    const { path } = await context.params;
    let result: unknown;
    if (request.method === "GET" && path.length === 1 && path[0] === "workspace") {
      result = await services.ddtDebug.workspace(personalScope);
    } else if (request.method === "GET" && path.length === 1 && path[0] === "cases") {
      const query = z
        .object({
          query: z.string().max(200),
          cursor: z.string().max(512).optional(),
          limit: z.coerce.number().int().min(1).max(50),
        })
        .parse({
          query: url.searchParams.get("query") ?? "",
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: url.searchParams.get("limit") ?? 50,
        });
      result = await services.ddtDebug.list(personalScope, {
        query: query.query,
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
    } else if (path.length === 2 && path[0] === "cases" && request.method === "GET") {
      result = await services.ddtDebug.get(personalScope, caseIdSchema.parse(path[1]));
    } else if (path.length === 2 && path[0] === "cases" && request.method === "PUT") {
      const input = updateSchema.parse(await readJsonBody(request, 2 * 1024 * 1024));
      result = await services.ddtDebug.update(
        personalScope,
        caseIdSchema.parse(path[1]),
        input.data,
        input.revision,
      );
    } else if (path.length === 1 && path[0] === "copy" && request.method === "POST") {
      const input = z
        .object({ caseId: caseIdSchema })
        .strict()
        .parse(await readJsonBody(request, 2048));
      result = await services.ddtDebug.copy(personalScope, input.caseId);
    } else if (path.join("/") === "imports/preview" && request.method === "POST") {
      result = await services.ddtImports.preview(
        { ...scope, debugOwnerId: identity.user.id },
        await readDdtUploads(request, services.configurationStore.read().limits.ddtImportFileLimit),
        identity.user.id,
      );
    } else if (path[0] === "imports" && path[1] && path.length <= 3) {
      const job = await services.ddtImports.get(path[1], [scope.projectId]);
      if (
        !job ||
        job.debugOwnerId !== identity.user.id ||
        job.projectVersionId !== scope.projectVersionId ||
        job.testStageId !== scope.testStageId
      )
        throw new DomainError("DDT_IMPORT_NOT_FOUND", "个人导入任务不存在。");
      if (request.method === "GET" && path.length === 2) result = job;
      else if (request.method === "POST" && path[2] === "confirm") {
        const input = confirmDdtImportInputSchema.parse(await readJsonBody(request, 16384));
        result = await services.ddtImports.confirm(job.id, input.conflictStrategy, [
          scope.projectId,
        ]);
      } else if (request.method === "POST" && path[2] === "resolve-columns") {
        const input = resolveDdtImportColumnsInputSchema.parse(
          await readJsonBody(request, 2 * 1024 * 1024),
        );
        result = await services.ddtImports.resolveColumnConflicts(job.id, input.columnResolutions, [
          scope.projectId,
        ]);
      } else if (request.method === "POST" && path[2] === "cancel")
        result = await services.ddtImports.cancel(job.id, [scope.projectId]);
    }
    if (result === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "调试接口不存在。");
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
