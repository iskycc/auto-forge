import { NextResponse } from "next/server";
import { publicSuiteLinkQuerySchema } from "@autoforge/contracts";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request, context: { params: Promise<{ suiteId: string }> }) {
  try {
    const { suiteId } = await context.params;
    const query = publicSuiteLinkQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return NextResponse.json(
      await (await getPlatformServices()).publicSuiteExecutions.read(suiteId, query.PublisherId),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}
