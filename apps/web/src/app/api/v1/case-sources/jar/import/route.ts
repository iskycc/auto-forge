import { createHash } from "node:crypto";

import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { apiErrorResponse, readJarUpload } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import {
  authenticateRequest,
  authorizedProjectScope,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const requestedProjectId = new URL(request.url).searchParams.get("projectId")?.trim();
    const projectScope = authorizedProjectScope(
      identity,
      "case_source.manage",
      requestedProjectId || undefined,
    );
    const projectId = requestedProjectId || projectScope?.at(0) || DEFAULT_PROJECT_ID;
    const upload = await readJarUpload(request, services.config.maxJarBytes);
    const sha256 = createHash("sha256").update(upload.content).digest("hex");
    const requestedKey = request.headers.get("Idempotency-Key")?.trim();
    const result = await services.importTestNgJar.enqueue({
      ...upload,
      projectId,
      actorId: identity.user.id,
      sha256,
      idempotencyKey: requestedKey || `sha256:${sha256}`,
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_source.import_queued",
      resourceType: "jar_import_job",
      resourceId: result.id,
      projectId,
      requestId: currentRequestId,
      details: { fileName: upload.fileName, sizeBytes: upload.content.byteLength },
    });
    return NextResponse.json(result, { status: result.status === "queued" ? 202 : 200 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
