import {
  bulkDdtCaseIdsInputSchema,
  bulkUpdateDdtCasesInputSchema,
  confirmDdtImportInputSchema,
  ddtCaseListInputSchema,
  setDdtExecutionClassInputSchema,
  updateDdtCaseInputSchema,
  upsertDdtTemplateInputSchema,
} from "@autoforge/contracts";
import type { AuthenticatedIdentity, DdtScope, Permission } from "@autoforge/domain";
import { DomainError } from "@autoforge/domain";
import { buildExportWorkbook } from "@autoforge/ddt-import";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, readDdtUploads, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { authorizeDdtScope } from "@/lib/ddt-api";

export const runtime = "nodejs";

type Context = { params: Promise<{ path: string[] }> };

const restoreHistorySchema = z.object({
  snapshot: z.enum(["before", "after"]).default("after"),
});
const exportSchema = z.object({
  caseIds: z.array(z.string().min(1).max(512)).max(5_000).optional(),
  srNum: z.string().trim().min(1).max(512).optional(),
});

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const url = new URL(request.url);
    const { scope, services } = await authorizeDdtScope(identity, "case.read", url);
    const path = await pathSegments(context);

    if (matches(path, "dashboard"))
      return NextResponse.json(await services.ddtCases.dashboard(scope));
    if (matches(path, "groups")) {
      return NextResponse.json({
        items: await services.ddtCases.groups(
          scope,
          url.searchParams.get("query") ?? undefined,
          boundedLimit(url, 100, 500),
        ),
      });
    }
    if (matches(path, "execution-classes")) {
      return NextResponse.json({
        items: await services.ddtCases.executionClasses(
          scope,
          url.searchParams.get("query") ?? undefined,
          boundedLimit(url, 50, 100),
        ),
      });
    }
    if (matches(path, "cases")) {
      const input = ddtCaseListInputSchema.parse({
        ...scope,
        query: url.searchParams.get("query") ?? undefined,
        srNum: url.searchParams.get("srNum") ?? undefined,
        sourceName: url.searchParams.get("sourceName") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
        filters: parseFilters(url.searchParams.get("filters")),
      });
      return NextResponse.json(await services.ddtCases.list(input));
    }
    if (path[0] === "cases" && path[1] && path.length === 2) {
      return NextResponse.json(await services.ddtCases.get(scope, path[1]));
    }
    if (path[0] === "cases" && path[1] && path[2] === "history" && path.length === 3) {
      return NextResponse.json(
        await services.ddtCases.history(
          scope,
          path[1],
          url.searchParams.get("cursor") ?? undefined,
          boundedLimit(url, 30, 100),
        ),
      );
    }
    if (matches(path, "templates")) {
      return NextResponse.json({ items: await services.ddtCases.templates(scope) });
    }
    if (matches(path, "recycle")) {
      return NextResponse.json(
        await services.ddtCases.listDeleted(
          scope,
          url.searchParams.get("query") ?? undefined,
          url.searchParams.get("cursor") ?? undefined,
          boundedLimit(url, 60, 100),
        ),
      );
    }
    if (matches(path, "imports")) {
      return NextResponse.json(
        await services.ddtImports.list(
          scope,
          url.searchParams.get("cursor") ?? undefined,
          boundedLimit(url, 50, 100),
        ),
      );
    }
    if (path[0] === "imports" && path[1] && path.length <= 3) {
      const job = await services.ddtImports.get(path[1], [scope.projectId]);
      assertJobScope(job, scope);
      if (path[2] === "case-ids") {
        return NextResponse.json({
          items: await services.ddtImports.caseIds(path[1], [scope.projectId]),
        });
      }
      if (path.length === 2) return NextResponse.json(job);
    }
    if (matches(path, "export")) {
      const selection = exportSchema.parse({
        caseIds: url.searchParams.getAll("caseId"),
        srNum: url.searchParams.get("srNum") ?? undefined,
      });
      return exportResponse(await services.ddtCases.export(scope, exportSelection(selection)));
    }
    throw routeNotFound();
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const requestedPath = await pathSegments(context);
  const permission =
    matches(requestedPath, "cases", "search") || matches(requestedPath, "export")
      ? "case.read"
      : "case.manage";
  return mutate(
    request,
    context,
    permission,
    async ({ identity, scope, services, path, currentRequestId }) => {
      if (matches(path, "cases", "search")) {
        const body = z
          .object({
            query: z.string().trim().max(512).optional(),
            srNum: z.string().trim().max(512).optional(),
            sourceName: z.string().trim().max(512).optional(),
            cursor: z.string().max(1_024).optional(),
            limit: z.number().int().min(1).max(200).default(60),
            filters: ddtCaseListInputSchema.shape.filters,
          })
          .parse(await readJsonBody(request, 128 * 1_024));
        return NextResponse.json(
          await services.ddtCases.list(ddtCaseListInputSchema.parse({ ...scope, ...body })),
        );
      }
      if (matches(path, "cases", "bulk-update")) {
        const input = bulkUpdateDdtCasesInputSchema.parse(
          await readJsonBody(request, 4 * 1_024 * 1_024),
        );
        const result = await services.ddtCases.bulkUpdate(
          scope,
          input.caseIds,
          input.field,
          input.value,
          input.stepName,
          ddtActorId(identity),
        );
        await audit(identity, services, scope, currentRequestId, "ddt_case.bulk_update", result);
        return NextResponse.json(result);
      }
      if (matches(path, "cases", "execution-class")) {
        const input = setDdtExecutionClassInputSchema.parse(
          await readJsonBody(request, 4 * 1_024 * 1_024),
        );
        const result = await services.ddtCases.setExecutionClass(
          scope,
          input.caseIds,
          input.className,
          ddtActorId(identity),
        );
        await audit(identity, services, scope, currentRequestId, "ddt_case.execution_class", {
          updatedCount: result.updatedCount,
          executionClassName: result.executionClass.className,
        });
        return NextResponse.json(result);
      }
      if (matches(path, "cases", "bulk-delete")) {
        const input = bulkDdtCaseIdsInputSchema.parse(
          await readJsonBody(request, 4 * 1_024 * 1_024),
        );
        const deletedCount = await services.ddtCases.trash(
          scope,
          input.caseIds,
          ddtActorId(identity),
        );
        await audit(identity, services, scope, currentRequestId, "ddt_case.trash", {
          deletedCount,
        });
        return NextResponse.json({ deletedCount });
      }
      if (matches(path, "templates")) {
        const input = upsertDdtTemplateInputSchema.parse(await readJsonBody(request, 256 * 1_024));
        const template = await services.ddtCases.writeTemplate(
          scope,
          input,
          undefined,
          ddtActorId(identity),
        );
        await audit(identity, services, scope, currentRequestId, "ddt_template.create", {
          templateId: template.id,
        });
        return NextResponse.json(template, { status: 201 });
      }
      if (matches(path, "imports", "preview")) {
        const job = await services.ddtImports.preview(
          scope,
          await readDdtUploads(request),
          ddtActorId(identity),
        );
        await audit(identity, services, scope, currentRequestId, "ddt_import.preview", {
          jobId: job.id,
          totalFiles: job.totalFiles,
        });
        return NextResponse.json(job, { status: 201 });
      }
      if (path[0] === "imports" && path[1] && path[2] === "confirm") {
        const input = confirmDdtImportInputSchema.parse(await readJsonBody(request, 16 * 1_024));
        const current = await services.ddtImports.get(path[1], [scope.projectId]);
        assertJobScope(current, scope);
        const job = await services.ddtImports.confirm(path[1], input.conflictStrategy, [
          scope.projectId,
        ]);
        await audit(identity, services, scope, currentRequestId, "ddt_import.confirm", {
          jobId: job.id,
          conflictStrategy: input.conflictStrategy,
        });
        return NextResponse.json(job);
      }
      if (path[0] === "imports" && path[1] && path[2] === "cancel") {
        const current = await services.ddtImports.get(path[1], [scope.projectId]);
        assertJobScope(current, scope);
        const job = await services.ddtImports.cancel(path[1], [scope.projectId]);
        await audit(identity, services, scope, currentRequestId, "ddt_import.cancel", {
          jobId: job.id,
        });
        return NextResponse.json(job);
      }
      if (
        path[0] === "cases" &&
        path[1] &&
        path[2] === "history" &&
        path[3] &&
        path[4] === "restore"
      ) {
        const input = restoreHistorySchema.parse(await readJsonBody(request, 16 * 1_024));
        const item = await services.ddtCases.restoreHistory(
          scope,
          path[1],
          path[3],
          input.snapshot,
          ddtActorId(identity),
        );
        await audit(identity, services, scope, currentRequestId, "ddt_case.history_restore", {
          caseId: item.caseId,
          historyId: path[3],
        });
        return NextResponse.json(item);
      }
      if (path[0] === "recycle" && path[1] && path[2] === "restore") {
        const item = await services.ddtCases.restoreDeleted(scope, path[1], ddtActorId(identity));
        await audit(identity, services, scope, currentRequestId, "ddt_case.recycle_restore", {
          caseId: item.caseId,
        });
        return NextResponse.json(item);
      }
      if (matches(path, "export")) {
        const selection = exportSchema.parse(await readJsonBody(request, 4 * 1_024 * 1_024));
        return exportResponse(await services.ddtCases.export(scope, exportSelection(selection)));
      }
      throw routeNotFound();
    },
  );
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  return mutate(
    request,
    context,
    "case.manage",
    async ({ identity, scope, services, path, currentRequestId }) => {
      if (path[0] === "cases" && path[1] && path.length === 2) {
        const input = updateDdtCaseInputSchema.parse(
          await readJsonBody(request, 8 * 1_024 * 1_024),
        );
        const item = await services.ddtCases.update(
          scope,
          path[1],
          input.expectedRevision,
          input.data,
          ddtActorId(identity),
        );
        await audit(identity, services, scope, currentRequestId, "ddt_case.update", {
          caseId: item.caseId,
        });
        return NextResponse.json(item);
      }
      if (path[0] === "templates" && path[1] && path.length === 2) {
        const input = upsertDdtTemplateInputSchema.parse(await readJsonBody(request, 256 * 1_024));
        const template = await services.ddtCases.writeTemplate(
          scope,
          input,
          path[1],
          ddtActorId(identity),
        );
        await audit(identity, services, scope, currentRequestId, "ddt_template.update", {
          templateId: template.id,
        });
        return NextResponse.json(template);
      }
      throw routeNotFound();
    },
  );
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  return mutate(
    request,
    context,
    "case.manage",
    async ({ identity, scope, services, path, currentRequestId }) => {
      if (path[0] === "cases" && path[1] && path.length === 2) {
        const deletedCount = await services.ddtCases.trash(scope, [path[1]], ddtActorId(identity));
        await audit(identity, services, scope, currentRequestId, "ddt_case.trash", {
          deletedCount,
        });
        return NextResponse.json({ deletedCount });
      }
      if (path[0] === "templates" && path[1] && path.length === 2) {
        const revision = z.coerce
          .number()
          .int()
          .min(1)
          .parse(new URL(request.url).searchParams.get("revision"));
        await services.ddtCases.deleteTemplate(scope, path[1], revision);
        await audit(identity, services, scope, currentRequestId, "ddt_template.delete", {
          templateId: path[1],
        });
        return new NextResponse(null, { status: 204 });
      }
      if (path[0] === "recycle" && path[1] && path.length === 2) {
        await services.ddtCases.purgeDeleted(scope, path[1]);
        await audit(identity, services, scope, currentRequestId, "ddt_case.recycle_purge", {
          recycleId: path[1],
        });
        return new NextResponse(null, { status: 204 });
      }
      throw routeNotFound();
    },
  );
}

async function mutate(
  request: Request,
  context: Context,
  permission: Permission,
  operation: (input: Awaited<ReturnType<typeof mutationContext>>) => Promise<NextResponse>,
): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    return await operation(await mutationContext(request, context, currentRequestId, permission));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

async function mutationContext(
  request: Request,
  context: Context,
  currentRequestId: string,
  permission: Permission,
) {
  const identity = await authenticateRequest(request);
  const { scope, services } = await authorizeDdtScope(identity, permission, new URL(request.url));
  return { identity, scope, services, path: await pathSegments(context), currentRequestId };
}

async function pathSegments(context: Context): Promise<string[]> {
  return (await context.params).path;
}

function matches(path: string[], ...expected: string[]): boolean {
  return path.length === expected.length && expected.every((part, index) => path[index] === part);
}

function boundedLimit(url: URL, fallback: number, maximum: number): number {
  const input = Number(url.searchParams.get("limit") ?? fallback);
  return Number.isInteger(input) ? Math.min(Math.max(input, 1), maximum) : fallback;
}

function parseFilters(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw new DomainError("DDT_FILTER_INVALID", "高级筛选条件不是有效的 JSON。", { cause: error });
  }
}

function assertJobScope(
  job: Awaited<ReturnType<import("@autoforge/application").DdtImportService["get"]>>,
  scope: DdtScope,
): asserts job {
  if (
    !job ||
    job.projectId !== scope.projectId ||
    job.projectVersionId !== scope.projectVersionId ||
    job.testStageId !== scope.testStageId
  )
    throw new DomainError("DDT_IMPORT_NOT_FOUND", "导入任务不存在。");
}

function exportResponse(
  rows: Awaited<ReturnType<import("@autoforge/application").DdtCaseService["export"]>>,
): NextResponse {
  const workbook = buildExportWorkbook(rows);
  return new NextResponse(new Uint8Array(workbook), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": "attachment; filename*=UTF-8''DDT-cases.xlsx",
      "cache-control": "no-store",
    },
  });
}

function exportSelection(selection: z.infer<typeof exportSchema>): {
  caseIds?: string[];
  srNum?: string;
} {
  return {
    ...(selection.caseIds?.length ? { caseIds: selection.caseIds } : {}),
    ...(selection.srNum ? { srNum: selection.srNum } : {}),
  };
}

async function audit(
  identity: Parameters<
    import("@autoforge/application").IdentityAccessService["recordAuthorizedOperation"]
  >[0],
  services: Awaited<ReturnType<typeof import("@/lib/services").getPlatformServices>>,
  scope: DdtScope,
  currentRequestId: string,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  await services.identityAccess.recordAuthorizedOperation(identity, {
    action,
    resourceType: "ddt_case",
    projectId: scope.projectId,
    requestId: currentRequestId,
    details: {
      ...details,
      projectVersionId: scope.projectVersionId,
      testStageId: scope.testStageId,
    },
  });
}

function routeNotFound(): DomainError {
  return new DomainError("DDT_ROUTE_NOT_FOUND", "DDT API 路径不存在。");
}

function ddtActorId(identity: AuthenticatedIdentity): string | undefined {
  return identity.sessionId.startsWith("api-token:") ? undefined : identity.user.id;
}
