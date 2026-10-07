import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api-response";
import { executionExceptionProjectScope } from "@/lib/execution-exceptions-access";
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
    const projectIds = await executionExceptionProjectScope(
      request,
      batchId,
      input.access_token,
      services,
    );
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
