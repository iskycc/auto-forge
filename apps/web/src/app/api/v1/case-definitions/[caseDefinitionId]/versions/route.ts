import { NextResponse } from "next/server";

import { authorizeRequest } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ caseDefinitionId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    await authorizeRequest(request, "case.read");
    const { caseDefinitionId } = await context.params;
    const services = await getPlatformServices();
    return NextResponse.json({
      items: await services.caseDefinitions.listVersions(caseDefinitionId),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
