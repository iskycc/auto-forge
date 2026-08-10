import { createHash } from "node:crypto";

import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse, bearerToken, rejectRateLimited } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string; artifactId: string }> };

export async function PUT(request: Request, context: Context): Promise<NextResponse> {
  try {
    const runnerId = request.headers.get("x-autoforge-runner-id")?.trim();
    const leaseToken = request.headers.get("x-autoforge-lease-token")?.trim();
    if (!runnerId || !leaseToken) {
      throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机或租约凭据。");
    }
    if (!request.body) throw new DomainError("ARTIFACT_BODY_REQUIRED", "产物内容不能为空。");
    const { attemptId, artifactId } = await context.params;
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `runner:artifact-upload:v1:${runnerId}`,
        300,
        60_000,
      ),
    );
    const result = await services.executionControl.uploadArtifact({
      runnerId,
      credential: bearerToken(request),
      attemptId,
      artifactId,
      leaseToken,
      content: requestContent(request.body),
    });
    return NextResponse.json({ artifactId: result.artifactId, status: result.status });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { attemptId, artifactId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "artifact.read");
    const artifact = (await services.executionControl.listArtifacts(attemptId, projectIds)).find(
      (candidate) => candidate.artifactId === artifactId,
    );
    if (!artifact?.objectKey || artifact.status !== "uploaded") {
      throw new DomainError("ARTIFACT_NOT_FOUND", "指定的产物不存在或尚未上传。");
    }
    const content = await services.objectStore.read(artifact.objectKey);
    if (content.byteLength !== artifact.sizeBytes) {
      throw new DomainError("ARTIFACT_CONTENT_INVALID", "产物大小与元数据不一致。");
    }
    if (createHash("sha256").update(content).digest("hex") !== artifact.sha256) {
      throw new DomainError("ARTIFACT_CONTENT_INVALID", "产物摘要与元数据不一致。");
    }
    return new NextResponse(Buffer.from(content), {
      headers: {
        "Content-Type": safeMediaType(artifact.mediaType),
        "Content-Length": String(content.byteLength),
        "Content-Disposition": `attachment; filename="${safeFileName(artifact.relativePath)}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

async function* requestContent(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function safeMediaType(mediaType: string): string {
  return mediaType.startsWith("image/") || mediaType === "application/pdf"
    ? mediaType
    : "application/octet-stream";
}

function safeFileName(relativePath: string): string {
  return (
    relativePath
      .split("/")
      .at(-1)
      ?.replace(/[^A-Za-z0-9._-]/g, "_") || "artifact.bin"
  );
}
