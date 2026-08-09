import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(): Promise<NextResponse> {
  try {
    const services = await getPlatformServices();
    return NextResponse.json({
      setupRequired: await services.identityAccess.setupRequired(),
      bootstrapEnabled: Boolean(services.config.adminBootstrapToken),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
