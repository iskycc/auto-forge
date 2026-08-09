import { apiErrorResponse, readJarUpload } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authorizeRequest, requireSameOrigin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    await authorizeRequest(request, "case_source.manage");
    const services = await getPlatformServices();
    const upload = await readJarUpload(request, services.config.maxJarBytes);
    const inspection = await services.discovery.inspect(upload.fileName, upload.content);
    return NextResponse.json(inspection);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
