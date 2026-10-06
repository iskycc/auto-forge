import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { readPermanentShareToken } from "@/lib/permanent-share-token";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({
  access_token: z.string().min(1).optional(),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  scope: z.enum(["all", "terminal"]).optional(),
});
export async function GET(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await context.params;
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const services = await getPlatformServices();
    let projectIds: readonly string[] | undefined;
    if (input.access_token) {
      if (
        readPermanentShareToken(services.config.masterKey, input.access_token, "run_batch") !==
        batchId
      )
        throw new DomainError("RUN_BATCH_SHARE_TOKEN_INVALID", "执行详情永久分享链接无效。");
    } else {
      const identity = await authenticateRequest(request);
      projectIds = services.identityAccess.projectScope(identity, "run.read");
    }
    const result = await services.executionExceptions({
      batchId,
      limit: input.limit,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(projectIds ? { projectIds } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}
