import { z } from "zod";
import { NextResponse } from "next/server";
import {
  ddtAssociationImportPreviewSchema,
  ddtAssociationImportEventSchema,
} from "@autoforge/contracts";
import type { DdtAssociationImportProgress } from "@autoforge/contracts";
import { DomainError, isDomainError } from "@autoforge/domain";
import { authenticateRequest, requireSameOrigin, requestId } from "@/lib/auth";
import { authorizeDdtScope } from "@/lib/ddt-api";
import { apiErrorResponse, readDdtAssociationUpload } from "@/lib/api-response";
import { logServerError, mapApiError } from "@/lib/api-error-mapping";
export async function POST(request: Request) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const url = new URL(request.url);
    const action = z.enum(["preview", "import"]).parse(url.searchParams.get("action") ?? "preview");
    const fingerprint =
      action === "import"
        ? z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .parse(url.searchParams.get("fingerprint"))
        : "";
    const identity = await authenticateRequest(request);
    const { scope, services } = await authorizeDdtScope(identity, "case.manage", url);
    const upload = await readDdtAssociationUpload(request);
    let plan: Awaited<ReturnType<typeof services.ddtAssociations.read>>;
    try {
      plan = await services.ddtAssociations.read(scope, upload, request.signal);
    } catch (cause) {
      if (isDomainError(cause)) throw cause;
      throw new DomainError(
        "DDT_ASSOCIATION_SPREADSHEET_INVALID",
        cause instanceof Error ? cause.message : "关联配置表格解析失败。",
        { cause },
      );
    }
    if (action === "preview")
      return NextResponse.json(ddtAssociationImportPreviewSchema.parse(plan.preview), {
        headers: { "cache-control": "private, no-store" },
      });
    if (plan.preview.issueCount)
      throw new DomainError("DDT_ASSOCIATION_IMPORT_INVALID", "表格存在问题，请修正后重新预览。", {
        details: plan.preview,
      });
    if (plan.preview.fingerprint !== fingerprint)
      throw new DomainError(
        "DDT_ASSOCIATION_IMPORT_CONFLICT",
        "文件或目标关联配置已变化，请检查新预览后重新确认。",
        { details: plan.preview },
      );
    const audit = (action: string, details: Record<string, unknown>) =>
      services.identityAccess.recordAuthorizedOperation(identity, {
        action,
        resourceType: "project_version",
        resourceId: scope.projectVersionId,
        projectId: scope.projectId,
        requestId: currentRequestId,
        details: { testStageId: scope.testStageId, ...details },
      });
    await audit("ddt_association.import_started", { rowCount: plan.preview.rowCount });
    const cancellation = new AbortController();
    const signal = AbortSignal.any([request.signal, cancellation.signal]);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: unknown) => {
          if (!cancelled && !signal.aborted)
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify(ddtAssociationImportEventSchema.parse(event)) + "\n",
              ),
            );
        };
        let processed = 0;
        const progress = (value: DdtAssociationImportProgress) => {
          processed = value.processed;
          send({ type: "progress", ...value });
        };
        void (async () => {
          try {
            const result = await services.ddtAssociations.apply(
              scope,
              plan,
              fingerprint,
              signal,
              progress,
            );
            await audit("ddt_association.import", result);
            send({ type: "completed", ...result });
          } catch (cause) {
            const partial = isDomainError(cause) ? cause.details : undefined;
            if (
              partial &&
              typeof partial === "object" &&
              "processed" in partial &&
              typeof partial.processed === "number"
            )
              processed = partial.processed;
            try {
              await audit("ddt_association.import_interrupted", { processed });
            } catch (auditFailure) {
              logServerError(
                auditFailure,
                currentRequestId,
                "Association import interruption audit failed",
              );
            }
            const mapped =
              isDomainError(cause) && cause.code === "DDT_ASSOCIATION_IMPORT_INTERRUPTED"
                ? cause
                : mapApiError(cause, currentRequestId).body.error;
            send({ type: "failed", code: mapped.code, message: mapped.message, processed });
          } finally {
            if (!cancelled) controller.close();
          }
        })();
      },
      cancel() {
        cancelled = true;
        cancellation.abort(new Error("关联配置导入已取消，已保存的变更保留。"));
      },
    });
    return new NextResponse(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "private, no-store",
        "x-request-id": currentRequestId,
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
