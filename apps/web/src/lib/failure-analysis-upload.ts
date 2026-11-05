import {
  completeFailureAnalysisInputSchema,
  FAILURE_ANALYSIS_IMAGE_MAXIMUM_BYTES,
  FAILURE_ANALYSIS_REMARK_IMAGE_LIMIT,
  FAILURE_ANALYSIS_REMARK_IMAGES_MAXIMUM_BYTES,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import type { FailureAnalysisImageUpload } from "@autoforge/application";

import { parseMultipartFormData, readJsonBody } from "./api-response";

const MAXIMUM_COMPLETION_JSON_BYTES = 32 * 1024;

export async function readFailureAnalysisScreenshotBody(request: Request): Promise<Uint8Array> {
  const tooLarge = () =>
    new DomainError("FAILURE_ANALYSIS_SCREENSHOT_SIZE_INVALID", "截图不能超过 10 MiB。");
  if (Number(request.headers.get("content-length")) > FAILURE_ANALYSIS_IMAGE_MAXIMUM_BYTES)
    throw tooLarge();
  if (!request.body)
    throw new DomainError("FAILURE_ANALYSIS_SCREENSHOT_REQUIRED", "请上传或粘贴截图。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FAILURE_ANALYSIS_IMAGE_MAXIMUM_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

export async function readFailureAnalysisCompletion(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
    return {
      input: completeFailureAnalysisInputSchema.parse(
        await readJsonBody(request, MAXIMUM_COMPLETION_JSON_BYTES),
      ),
      remarkImages: [] as FailureAnalysisImageUpload[],
    };
  }
  const tooLarge = () =>
    new DomainError("FAILURE_ANALYSIS_REMARK_IMAGES_LIMIT", "备注图片合计不能超过 20 MiB。");
  const form = await parseMultipartFormData(
    request,
    FAILURE_ANALYSIS_REMARK_IMAGES_MAXIMUM_BYTES + MAXIMUM_COMPLETION_JSON_BYTES,
    tooLarge,
  );
  const payload = form.get("input");
  if (
    typeof payload !== "string" ||
    new TextEncoder().encode(payload).byteLength > MAXIMUM_COMPLETION_JSON_BYTES
  ) {
    throw new DomainError("INVALID_JSON", "分析表单内容缺失或过大。");
  }
  const input = completeFailureAnalysisInputSchema.parse(
    await readJsonBody(
      new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
      MAXIMUM_COMPLETION_JSON_BYTES,
    ),
  );
  const files = form.getAll("remarkImages");
  if (files.length > FAILURE_ANALYSIS_REMARK_IMAGE_LIMIT) {
    throw new DomainError("FAILURE_ANALYSIS_REMARK_IMAGES_LIMIT", "备注最多包含 8 张图片。");
  }
  const remarkImages: FailureAnalysisImageUpload[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (
      !(file instanceof File) ||
      file.size === 0 ||
      file.size > FAILURE_ANALYSIS_IMAGE_MAXIMUM_BYTES
    ) {
      throw new DomainError(
        "FAILURE_ANALYSIS_SCREENSHOT_SIZE_INVALID",
        "图片不能为空，且单张不能超过 10 MiB。",
      );
    }
    totalBytes += file.size;
    if (totalBytes > FAILURE_ANALYSIS_REMARK_IMAGES_MAXIMUM_BYTES) throw tooLarge();
    remarkImages.push({
      fileName: file.name,
      mediaType: file.type,
      content: new Uint8Array(await file.arrayBuffer()),
    });
  }
  return { input, remarkImages };
}
