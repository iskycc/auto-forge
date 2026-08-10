import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  try {
    const services = await getPlatformServices();
    await services.catalog.getDashboardSummary();
    await services.objectStore.ready();
    await services.infrastructure.ready();
    return NextResponse.json({ status: "ready", mode: services.config.mode });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
