import { apiErrorResponse, readJarUpload } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const services = await getPlatformServices();
    const upload = await readJarUpload(request, services.config.maxJarBytes);
    const inspection = await services.discovery.inspect(upload.fileName, upload.content);
    return NextResponse.json(inspection);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
