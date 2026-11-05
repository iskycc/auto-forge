import { NextResponse } from "next/server";
import { z } from "zod";
import {
  attemptLogQuerySchema,
  completeFailureAnalysisSheetInputSchema,
  failureAnalysisClaimSchema,
  failureAnalysisSheetQuerySchema,
  failureAnalysisSheetSelectionSchema,
} from "@autoforge/contracts";
import { DomainError, type AuthenticatedIdentity } from "@autoforge/domain";
import { apiErrorResponse, readJsonBody } from "./api-response";
import { authenticateRequest, authorizeRequest, requestId, requireSameOrigin } from "./auth";
import { readFailureAnalysisScreenshotBody } from "./failure-analysis-upload";
import { getPlatformServices } from "./services";

type SheetAccess = "project" | "published";
const identifier = z.string().min(1).max(200);
const selection = z.object({ analysisIds: z.array(identifier).min(1).max(100) }).strict();
const responseHeaders = { "Cache-Control": "private, no-store" };

async function sheetScope(batchId: string, access: SheetAccess) {
  const services = await getPlatformServices();
  const scope = await (access === "published"
    ? services.analysisPublications.requirePublic(identifier.parse(batchId))
    : services.analysisPublications.requireBatch(identifier.parse(batchId)));
  return { services, scope };
}

async function sheetActor(
  request: Request,
  access: SheetAccess,
  projectId: string,
  operation: "read" | "write",
) {
  if (access === "project")
    return authorizeRequest(
      request,
      operation === "read" ? "run.read" : "analysis.manage",
      projectId,
    );
  const identity = await authenticateRequest(request);
  if (identity.sessionId.startsWith("api-token:"))
    throw new DomainError("AUTH_REQUIRED", "请使用个人账号登录后操作公开分析链接。");
  return identity;
}

export async function readAnalysisSheet(request: Request, batchId: string, access: SheetAccess) {
  try {
    const { services, scope } = await sheetScope(batchId, access);
    const query = failureAnalysisSheetQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const actor =
      access === "project" || query.view === "mine"
        ? await sheetActor(request, access, scope.projectId, "read")
        : undefined;
    return NextResponse.json(await services.analysisSheet.read(scope, query, actor?.user.id), {
      headers: responseHeaders,
    });
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}

export async function readAnalysisSheetResource(
  request: Request,
  batchId: string,
  resource: string,
  access: SheetAccess,
) {
  try {
    const { services, scope } = await sheetScope(batchId, access);
    if (access === "project") await sheetActor(request, access, scope.projectId, "read");
    const parameters = new URL(request.url).searchParams;
    if (resource === "logs") {
      if (access === "project") await authorizeRequest(request, "log.read", scope.projectId);
      const attemptId = await services.analysisPublications.requireFailureAttempt(
        scope,
        identifier.parse(parameters.get("executionRunId")),
      );
      const query = attemptLogQuerySchema.parse(Object.fromEntries(parameters));
      return NextResponse.json(
        await services.executionControl.listLogs({
          stream: query.stream,
          afterSequence: query.afterSequence,
          limit: query.limit,
          ...(query.query ? { query: query.query } : {}),
          ...(query.recordedAfter ? { recordedAfter: query.recordedAfter } : {}),
          ...(query.recordedBefore ? { recordedBefore: query.recordedBefore } : {}),
          attemptId,
          projectIds: [scope.projectId],
        }),
        { headers: responseHeaders },
      );
    }
    if (resource === "evidence") {
      const analysisId = identifier.parse(parameters.get("analysisId"));
      await services.analysisSheet.requireClaim(scope, analysisId);
      const imageId = identifier.optional().parse(parameters.get("imageId") ?? undefined);
      const image = imageId
        ? await services.failureAnalysis.readRemarkImage(analysisId, scope.projectId, imageId)
        : await services.failureAnalysis.readScreenshot(analysisId, scope.projectId);
      if (!image)
        throw new DomainError("FAILURE_ANALYSIS_EVIDENCE_NOT_FOUND", "分析证明图片不存在。");
      return new NextResponse(Buffer.from(image.content), {
        headers: {
          ...responseHeaders,
          "Content-Type": image.mediaType,
          "Content-Length": String(image.content.byteLength),
          "Content-Disposition": "inline",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'",
        },
      });
    }
    throw new DomainError("RESOURCE_NOT_FOUND", "此分析资源不存在。");
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}

export async function changeAnalysisSheet(
  request: Request,
  batchId: string,
  action: string,
  access: SheetAccess,
) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const { services, scope } = await sheetScope(batchId, access);
    const actor = await sheetActor(request, access, scope.projectId, "write");
    services.analysisSheet.requireWritable(scope);
    let result: unknown;
    if (action === "claim") {
      const input = failureAnalysisSheetSelectionSchema.parse(
        await readJsonBody(request, 32 * 1024),
      );
      result = await services.failureAnalysis.claim({ ...scope, ...input, claimant: actor.user });
    } else if (action === "complete") {
      const input = completeFailureAnalysisSheetInputSchema.parse(
        await readJsonBody(request, 32 * 1024),
      );
      result = {
        items: failureAnalysisClaimSchema
          .array()
          .parse(await services.analysisSheet.complete(scope, input, actor.user)),
      };
    } else if (action === "proof") {
      const parameters = new URL(request.url).searchParams;
      const analysisIds = selection.parse({
        analysisIds: parameters.getAll("analysisId"),
      }).analysisIds;
      await services.analysisSheet.requireOwned(scope, analysisIds, actor.user.id);
      const claims = await services.failureAnalysis.uploadScreenshot({
        projectId: scope.projectId,
        analysisIds,
        claimantId: actor.user.id,
        fileName: z.string().min(1).max(240).parse(parameters.get("fileName")),
        mediaType: request.headers.get("content-type") ?? "application/octet-stream",
        content: await readFailureAnalysisScreenshotBody(request),
      });
      result = { items: failureAnalysisClaimSchema.array().parse(claims) };
    } else if (action === "rerun-proofs") {
      const { analysisIds } = selection.parse(await readJsonBody(request, 32 * 1024));
      await services.analysisSheet.requireOwned(scope, analysisIds, actor.user.id);
      result = await services.failureAnalysis.lookupRerunProofs({
        projectId: scope.projectId,
        analysisIds,
        claimantId: actor.user.id,
      });
    } else if (action === "release") {
      const input = z
        .object({ analysisId: identifier, reason: z.string().trim().min(1).max(1000) })
        .strict()
        .parse(await readJsonBody(request, 8 * 1024));
      await services.analysisSheet.requireOwned(scope, [input.analysisId], actor.user.id);
      result = await services.failureAnalysis.releaseClaim({
        ...input,
        projectId: scope.projectId,
        claimantId: actor.user.id,
      });
    } else throw new DomainError("RESOURCE_NOT_FOUND", "此分析操作不存在。");
    await auditSheetOperation(
      services,
      actor,
      scope.projectId,
      batchId,
      action,
      access,
      currentRequestId,
    );
    return NextResponse.json(result, { headers: responseHeaders });
  } catch (cause) {
    return apiErrorResponse(cause, currentRequestId);
  }
}

async function auditSheetOperation(
  services: Awaited<ReturnType<typeof getPlatformServices>>,
  actor: AuthenticatedIdentity,
  projectId: string,
  batchId: string,
  action: string,
  access: SheetAccess,
  currentRequestId: string,
) {
  await services.identityAccess.recordAuthorizedOperation(actor, {
    action: `failure_analysis.sheet.${action}`,
    resourceType: "run_batch",
    resourceId: batchId,
    projectId,
    requestId: currentRequestId,
    details: { access },
  });
}
