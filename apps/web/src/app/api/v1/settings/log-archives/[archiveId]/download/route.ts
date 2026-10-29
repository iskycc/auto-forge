import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { DomainError } from "@autoforge/domain";
import { authorizeRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { exportContentDisposition } from "@/lib/export-filename";
export async function GET(request: Request, context: { params: Promise<{ archiveId: string }> }) {
  const id = requestId(request);
  try {
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    await authorizeRequest(request, "log.read", undefined);
    const archiveId = z
      .string()
      .uuid()
      .parse((await context.params).archiveId);
    const services = await getPlatformServices();
    const job = await services.logArchives.find(archiveId);
    if (!job.objectKey || !job.filename || !job.sha256)
      throw new DomainError("LOG_ARCHIVE_NOT_READY", "归档尚未通过完整性校验，暂不能下载。");
    if (job.copyState && job.copyState !== "retained")
      throw new DomainError(
        "LOG_ARCHIVE_OFFLINE",
        "平台归档副本已离线或正在移除，请使用已下载的归档包。",
      );
    const file = await services.objectStore.openRead(job.objectKey);
    if (file.sizeBytes !== job.archiveBytes)
      throw new DomainError(
        "LOG_ARCHIVE_UNAVAILABLE",
        "归档文件大小与校验记录不符，请检查存储完整性。",
      );
    const content = (async function* () {
      let transferred = 0;
      const digest = createHash("sha256");
      for await (const chunk of file.content) {
        if (request.signal.aborted) return;
        transferred += chunk.byteLength;
        digest.update(chunk);
        yield chunk;
      }
      if (!request.signal.aborted && request.method === "GET") {
        if (transferred !== job.archiveBytes || digest.digest("hex") !== job.sha256)
          throw new DomainError(
            "LOG_ARCHIVE_UNAVAILABLE",
            "下载内容与归档校验值不符，请检查存储完整性；本次下载未确认完成。",
          );
        await services.logArchives.recordDownload(
          job.id,
          identity.user.id,
          job.sha256!,
          transferred,
        );
      }
    })();
    return new Response(
      Readable.toWeb(Readable.from(content)) as ReadableStream<Uint8Array<ArrayBuffer>>,
      {
        headers: {
          "content-type": "application/zip",
          "content-length": String(file.sizeBytes),
          "content-disposition": exportContentDisposition(job.filename),
          "cache-control": "private, no-store",
          "x-content-sha256": job.sha256,
          "x-content-type-options": "nosniff",
        },
      },
    );
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}
