import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { toExecutionBatchView } from "@/lib/execution-batch-view";
import { executionReadProjectScope } from "@/lib/execution-public-access";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ batchId: string }> };

const querySchema = z.object({
  public: z.literal("1").optional(),
  access_token: z.string().min(1).optional(),
});

/** 有界的批次实时概要；不会读取或序列化整批 ExecutionRun/RunAttempt。 */
export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const { batchId } = await context.params;
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const services = await getPlatformServices();
    const projectIds = await executionReadProjectScope(
      request,
      batchId,
      { accessToken: input.access_token, publicAccess: input.public === "1" },
      services,
    );
    const overview = await services.executionOverview(batchId, projectIds);
    const runners = await services.runnerControl.listByIds(overview.participatingRunnerIds);
    return NextResponse.json(
      {
        ...toExecutionBatchView(overview),
        runnerNames: runners.map(({ id, name }) => ({ id, name })),
      },
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
