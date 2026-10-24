import { z } from "zod";
import { NextResponse } from "next/server";
import { srTagImportPreviewSchema, srTagImportResultSchema } from "@autoforge/contracts";
import { DomainError, isDomainError } from "@autoforge/domain";
import { authorizeSrTagScope } from "@/lib/ddt-sr-tag-api";
import { apiErrorResponse, readSrTagUpload } from "@/lib/api-response";
import { requireSameOrigin, requestId } from "@/lib/auth";
export async function POST(request: Request) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const url = new URL(request.url);
    const action = z.enum(["preview", "import"]).parse(url.searchParams.get("action") ?? "preview");
    const { scope, services, identity } = await authorizeSrTagScope(request, url, "case.manage");
    const upload = await readSrTagUpload(request);
    let inspected: Awaited<ReturnType<typeof services.ddtSrTagImports.read>>;
    try {
      inspected = await services.ddtSrTagImports.read(scope, upload, request.signal);
    } catch (cause) {
      if (isDomainError(cause)) throw cause;
      throw new DomainError(
        "SR_TAG_SPREADSHEET_INVALID",
        cause instanceof Error ? cause.message : "表格解析失败，请检查文件。",
        { cause },
      );
    }
    if (action === "preview")
      return NextResponse.json(srTagImportPreviewSchema.parse(inspected.preview));
    if (inspected.preview.issueCount)
      throw new DomainError("SR_TAG_IMPORT_INVALID", "表格存在问题，请修正后重新预览。", {
        details: inspected.preview,
      });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "ddt_sr_tag.import_started",
      resourceType: "project_version",
      resourceId: scope.projectVersionId,
      projectId: scope.projectId,
      requestId: currentRequestId,
      details: { rowCount: inspected.preview.rowCount },
    });
    const result = await services.ddtSrTagImports.apply(
      scope,
      inspected.parsed,
      inspected.preview,
      request.signal,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "ddt_sr_tag.import",
      resourceType: "project_version",
      resourceId: scope.projectVersionId,
      projectId: scope.projectId,
      requestId: currentRequestId,
      details: result,
    });
    return NextResponse.json(srTagImportResultSchema.parse(result));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
