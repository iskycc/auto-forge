import {
  failureAnalysisClaimSchema,
  uploadFailureAnalysisEvidenceQuerySchema,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { FAILURE_ANALYSIS_SCREENSHOT_MAXIMUM_BYTES } from "@autoforge/application";
import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const url = new URL(request.url);
    const input = uploadFailureAnalysisEvidenceQuerySchema.parse({
      projectId: url.searchParams.get("projectId"),
      analysisIds: url.searchParams.getAll("analysisId"),
      fileName: url.searchParams.get("fileName"),
    });
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "analysis.manage", input.projectId);
    const claims = await services.failureAnalysis.uploadScreenshot({
      projectId: input.projectId,
      analysisIds: input.analysisIds,
      claimantId: identity.user.id,
      fileName: input.fileName,
      mediaType: request.headers.get("content-type") ?? "application/octet-stream",
      content: await readBoundedBody(request),
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "failure_analysis.evidence.upload",
      resourceType: "failure_analysis",
      resourceId: claims[0]!.id,
      projectId: input.projectId,
      requestId: currentRequestId,
      details: { count: claims.length, sizeBytes: claims[0]?.screenshot?.sizeBytes ?? 0 },
    });
    return NextResponse.json(
      { items: failureAnalysisClaimSchema.array().parse(claims) },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > FAILURE_ANALYSIS_SCREENSHOT_MAXIMUM_BYTES) {
    throw tooLarge();
  }
  if (!request.body) throw new DomainError("FAILURE_ANALYSIS_SCREENSHOT_REQUIRED", "请粘贴截图。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > FAILURE_ANALYSIS_SCREENSHOT_MAXIMUM_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const content = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function tooLarge(): DomainError {
  return new DomainError("FAILURE_ANALYSIS_SCREENSHOT_SIZE_INVALID", "截图不能超过 10 MiB。");
}
