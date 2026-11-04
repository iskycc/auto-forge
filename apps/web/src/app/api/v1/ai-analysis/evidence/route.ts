import { z } from "zod";
import { DomainError } from "@autoforge/domain";
import { authenticateRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { apiErrorResponse } from "@/lib/api-response";

const query = z.object({
  batchId: z.string().min(1).max(128),
  jobId: z.string().min(1).max(128),
  itemId: z.string().min(1).max(300),
  partId: z.string().min(1).max(128).optional(),
  after: z.coerce.number().int().nonnegative().default(0),
});
const manifestSchema = z.object({
  version: z.literal(1),
  attemptId: z.string(),
  executionRunId: z.string(),
  limitations: z.array(z.string()),
  parts: z.array(
    z.object({ id: z.string(), objectKey: z.string(), sizeBytes: z.number().int().nonnegative() }),
  ),
});
export async function GET(request: Request) {
  try {
    const actor = await authenticateRequest(request);
    const input = query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const services = await getPlatformServices();
    const view = await services.aiAnalysis.view(actor, {
      batchId: input.batchId,
      jobId: input.jobId,
      limit: 1,
    });
    if (!view) throw new DomainError("AI_JOB_NOT_FOUND", "初析记录不存在。");
    const reference = await services.aiAnalysis.repository.evidenceReference(
      input.jobId,
      input.itemId,
    );
    if (!reference) throw new DomainError("AI_EVIDENCE_NOT_FOUND", "证据尚未准备完成或已清理。");
    const manifest = manifestSchema.parse(
      JSON.parse(Buffer.from(await services.objectStore.read(reference)).toString("utf8")),
    );
    if (input.partId) {
      const part = manifest.parts.find((part) => part.id === input.partId);
      if (!part) throw new DomainError("AI_EVIDENCE_NOT_FOUND", "证据块不存在。");
      return Response.json(
        {
          attemptId: manifest.attemptId,
          evidenceId: part.id,
          text: Buffer.from(await services.objectStore.read(part.objectKey)).toString("utf8"),
        },
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    return Response.json(
      {
        version: 1,
        attemptId: manifest.attemptId,
        executionRunId: manifest.executionRunId,
        limitations: manifest.limitations,
        totalParts: manifest.parts.length,
        parts: manifest.parts
          .slice(input.after, input.after + 50)
          .map(({ id, sizeBytes }) => ({ id, sizeBytes })),
        nextOffset: input.after + 50 < manifest.parts.length ? input.after + 50 : null,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
