import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";

type Context = { params: Promise<{ suiteId: string }> };

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  try {
    const { suiteId } = await context.params;
    return NextResponse.json(await (await getPlatformServices()).caseSuites.get(suiteId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
