import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth";

type Context = { params: Promise<{ sourceId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    await authorizeRequest(request, "case_source.read");
    const { sourceId } = await context.params;
    return NextResponse.json(await (await getPlatformServices()).caseSources.get(sourceId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
