import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";

type Context = { params: Promise<{ batchId: string }> };

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  try {
    const { batchId } = await context.params;
    return NextResponse.json(await (await getPlatformServices()).runBatches.get(batchId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
