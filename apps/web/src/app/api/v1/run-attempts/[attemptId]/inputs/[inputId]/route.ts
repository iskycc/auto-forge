import { Readable } from "node:stream";

import { DomainError } from "@autoforge/domain";

import { apiErrorResponse, bearerToken, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string; inputId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const runnerId = request.headers.get("x-autoforge-runner-id")?.trim();
    const leaseToken = request.headers.get("x-autoforge-lease-token")?.trim();
    if (!runnerId) throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机标识。");
    if (!leaseToken) throw new DomainError("LEASE_AUTH_REQUIRED", "缺少任务租约凭据。");
    const { attemptId, inputId } = await context.params;
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(`runner:input:v1:${runnerId}`, 120, 60_000),
    );
    const authorized = await services.executionControl.resolveInput(
      runnerId,
      bearerToken(request),
      attemptId,
      inputId,
      leaseToken,
    );
    let body: BodyInit;
    if (authorized.kind === "inline") {
      if (authorized.content.byteLength !== authorized.sizeBytes)
        throw new DomainError("ATTEMPT_INPUT_CORRUPTED", "输入对象大小与登记信息不一致。");
      body = Uint8Array.from(authorized.content).buffer;
    } else {
      const object =
        authorized.kind === "url"
          ? await services.runtimeArchiveCache
              .open(authorized, request.signal)
              .catch((cause: unknown) => {
                throw new DomainError(
                  "ATTEMPT_INPUT_DOWNLOAD_FAILED",
                  "主平台下载或校验运行时压缩包失败，请检查 URL、SHA-256、文件大小及平台缓存磁盘空间。",
                  { cause },
                );
              })
          : await services.objectStore.openRead(authorized.objectKey);
      if (object.sizeBytes !== authorized.sizeBytes) {
        // Return the iterator even before the response starts, releasing its file/socket.
        await object.content[Symbol.asyncIterator]().return?.();
        throw new DomainError("ATTEMPT_INPUT_CORRUPTED", "输入对象大小与登记信息不一致。");
      }
      body = Readable.toWeb(Readable.from(object.content)) as ReadableStream<Uint8Array>;
    }
    return new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition":
          authorized.mediaType === "application/json"
            ? 'attachment; filename="class-data.json"'
            : authorized.mediaType === "application/java-archive"
              ? 'attachment; filename="tests.jar"'
              : 'attachment; filename="runtime-archive.bin"',
        "Content-Length": String(authorized.sizeBytes),
        "Content-Type": authorized.mediaType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
