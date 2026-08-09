import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth";

type Context = { params: Promise<{ suiteId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    await authorizeRequest(request, "case_suite.read");
    const { suiteId } = await context.params;
    return NextResponse.json(await (await getPlatformServices()).caseSuites.get(suiteId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
