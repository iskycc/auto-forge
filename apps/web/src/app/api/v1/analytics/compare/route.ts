import { batchComparisonManifestSchema, batchComparisonPartSchema } from "@autoforge/contracts";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { readReadySnapshot } from "@/lib/read-ready-model";

const querySchema = z.object({
  leftBatchId: z.string().min(1).max(128),
  rightBatchId: z.string().min(1).max(128),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const identity = await authenticateRequest(request);
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    const [left, right] = await Promise.all([
      services.runBatches.getMetadata(input.leftBatchId, projectIds),
      services.runBatches.getMetadata(input.rightBatchId, projectIds),
    ]);
    const query = {
      kind: "batch_comparison" as const,
      projectId: left.projectId,
      rightProjectId: right.projectId,
      ...input,
    };
    const snapshot = await readReadySnapshot(services.readModels, query, request.signal);
    const manifest = batchComparisonManifestSchema.parse(snapshot.payload);
    const encoder = new TextEncoder();
    let ordinal = -1;
    let hasCases = false;
    // Preserve the existing JSON shape with bounded serialization and network backpressure.
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          request.signal.throwIfAborted();
          if (ordinal === -1) {
            const header = {
              left: manifest.left,
              right: manifest.right,
              commonCaseCount: manifest.commonCaseCount,
              onlyLeftCaseCount: manifest.onlyLeftCaseCount,
              onlyRightCaseCount: manifest.onlyRightCaseCount,
              comparableScope: manifest.comparableScope,
            };
            controller.enqueue(encoder.encode(`${JSON.stringify(header).slice(0, -1)},"cases":[`));
            ordinal = 0;
            return;
          }
          if (ordinal < manifest.partCount) {
            const part = batchComparisonPartSchema.parse(
              await services.readModels.part(snapshot.id, snapshot.generation!, ordinal++),
            );
            if (part.length) {
              controller.enqueue(
                encoder.encode(`${hasCases ? "," : ""}${JSON.stringify(part).slice(1, -1)}`),
              );
              hasCases = true;
            }
            return;
          }
          controller.enqueue(encoder.encode("]}"));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, requestId(request));
  }
}
