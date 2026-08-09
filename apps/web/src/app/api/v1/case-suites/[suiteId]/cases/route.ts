import { updateCaseSuiteItemsInputSchema } from "@autoforge/contracts";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";

type Context = { params: Promise<{ suiteId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const input = updateCaseSuiteItemsInputSchema.parse(await request.json());
    const { suiteId } = await context.params;
    return NextResponse.json(
      await (await getPlatformServices()).caseSuites.addCases(suiteId, input.caseDefinitionIds),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
