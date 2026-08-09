import { setAuthoritativeSourceInputSchema } from "@autoforge/contracts";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";

type Context = { params: Promise<{ sourceId: string }> };

export async function PUT(request: Request, context: Context): Promise<NextResponse> {
  try {
    setAuthoritativeSourceInputSchema.parse(await request.json());
    const { sourceId } = await context.params;
    return NextResponse.json(
      await (await getPlatformServices()).caseSources.setAuthoritative(sourceId),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
