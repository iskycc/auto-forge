import { z } from "zod";
import { NextResponse } from "next/server";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { runnerRejectedContactsPageSchema } from "@autoforge/contracts";
import { authorizeRequest } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  cursor: z.uuid().optional(),
});
export async function GET(request: Request): Promise<NextResponse> {
  try {
    await authorizeRequest(request, "runner.manage", DEFAULT_PROJECT_ID);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const page = await (
      await getPlatformServices()
    ).deletedRunnerContacts.list({
      limit: query.limit,
      ...(query.cursor ? { afterId: query.cursor } : {}),
    });
    return NextResponse.json(runnerRejectedContactsPageSchema.parse(page), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}
