import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";

type Context = { params: Promise<{ suiteId: string; caseDefinitionId: string }> };

export async function DELETE(_request: Request, context: Context): Promise<NextResponse> {
  try {
    const { suiteId, caseDefinitionId } = await context.params;
    return NextResponse.json(
      await (await getPlatformServices()).caseSuites.removeCase(suiteId, caseDefinitionId),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
