import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  try {
    await getPlatformServices().catalog.getDashboardSummary();
    return NextResponse.json({ status: "ready", mode: "lite" });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
