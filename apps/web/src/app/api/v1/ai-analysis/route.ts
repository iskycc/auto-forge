import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { executionReadProjectScope } from "@/lib/execution-public-access";
import {
  executionShareAccess,
  executionShareQuerySchema,
  hasExecutionShareAccess,
} from "@/lib/execution-share-query";
import { getPlatformServices } from "@/lib/services";

const querySchema = executionShareQuerySchema.extend({
  batchId: z.string().min(1).max(128),
  jobId: z.string().min(1).max(128).optional(),
  attemptId: z.string().min(1).max(128).optional(),
  after: z.string().max(300).optional(),
  groupAfter: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(10).default(10),
});
export async function GET(request: Request) {
  try {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const services = await getPlatformServices();
    const selection = {
      batchId: input.batchId,
      limit: input.limit,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(input.after ? { after: input.after } : {}),
      ...(input.groupAfter ? { groupAfter: input.groupAfter } : {}),
    };
    const headers = { "Cache-Control": "private, no-store" };
    const access = executionShareAccess(input);
    if (!hasExecutionShareAccess(access))
      return Response.json(
        await services.aiAnalysis.view(await authenticateRequest(request), selection),
        { headers },
      );

    await executionReadProjectScope(request, input.batchId, access, services);
    const view = await services.aiAnalysis.repository.view(selection);
    return Response.json(
      view
        ? {
            job: {
              status: view.job.status,
              acceptingFinalResults: view.job.acceptingFinalResults,
              total: view.job.total,
              prepared: view.job.prepared,
              completed: view.job.completed,
              failed: view.job.failed,
            },
            items: view.items.map(({ id, displayName, status, conclusion }) => ({
              id,
              displayName,
              status,
              conclusion,
            })),
            nextCursor: view.nextCursor,
          }
        : null,
      { headers },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor = await authenticateRequest(request);
    return Response.json(
      await (
        await getPlatformServices()
      ).aiAnalysis.create(actor, await readJsonBody(request, 4096)),
      { status: 202 },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request);
    const actor = await authenticateRequest(request);
    const input = z
      .object({ batchId: z.string().min(1).max(128), jobId: z.string().min(1).max(128) })
      .strict()
      .parse(await readJsonBody(request, 4096));
    await (await getPlatformServices()).aiAnalysis.cancel(actor, input.batchId, input.jobId);
    return Response.json({ cancelled: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
