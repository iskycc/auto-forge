import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET() {
  try {
    const { clock } = await getPlatformServices();
    return NextResponse.json(
      { schemaVersion: 1, serverTime: clock.now().toISOString() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
