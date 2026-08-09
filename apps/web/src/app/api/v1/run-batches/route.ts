import { createRunBatchInputSchema } from "@autoforge/contracts";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { z } from "zod";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const { limit } = querySchema.parse({ limit: url.searchParams.get("limit") ?? undefined });
    const services = await getPlatformServices();
    return NextResponse.json({ items: await services.runBatches.list(limit) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const input = createRunBatchInputSchema.parse(await readJsonBody(request, 128 * 1024));
    const batch = await (await getPlatformServices()).runBatches.create(input);
    return NextResponse.json(batch, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
