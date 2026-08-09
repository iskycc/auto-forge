import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";

type Context = { params: Promise<{ sourceId: string }> };

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  try {
    const { sourceId } = await context.params;
    return NextResponse.json(await (await getPlatformServices()).caseSources.get(sourceId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
