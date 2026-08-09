import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth";

type Context = { params: Promise<{ batchId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    await authorizeRequest(request, "run.read");
    const { batchId } = await context.params;
    return NextResponse.json(await (await getPlatformServices()).runBatches.get(batchId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
