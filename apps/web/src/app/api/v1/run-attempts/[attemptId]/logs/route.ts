import { attemptLogQuerySchema, uploadLogChunksInputSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse, bearerToken, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { attemptId } = await context.params;
    const query = attemptLogQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "log.read");
    return NextResponse.json(
      await services.executionControl.listLogs({
        attemptId,
        stream: query.stream,
        afterSequence: query.afterSequence,
        limit: query.limit,
        ...(projectIds ? { projectIds } : {}),
        ...(query.query ? { query: query.query } : {}),
        ...(query.recordedAfter ? { recordedAfter: query.recordedAfter } : {}),
        ...(query.recordedBefore ? { recordedBefore: query.recordedBefore } : {}),
      }),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const runnerId = request.headers.get("x-autoforge-runner-id")?.trim();
    if (!runnerId) throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机标识。");
    const { attemptId } = await context.params;
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(`runner:logs:v1:${runnerId}`, 600, 60_000),
    );
    const input = uploadLogChunksInputSchema.parse(await readJsonBody(request, 2 * 1024 * 1024));
    const result = await services.runnerProtocol.uploadLogs(
      runnerId,
      bearerToken(request),
      attemptId,
      input,
    );
    const runtime = globalThis as typeof globalThis & {
      __autoforgePublishAttemptLogs?: (
        attemptId: string,
        chunks: Array<{
          stream: "stdout" | "stderr" | "agent";
          sequence: number;
          content: string;
          recordedAt: string;
        }>,
      ) => void;
    };
    runtime.__autoforgePublishAttemptLogs?.(attemptId, input.chunks);
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
