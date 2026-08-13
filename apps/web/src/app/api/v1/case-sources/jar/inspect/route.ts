import { apiErrorResponse, readJarUpload } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authenticateRequest, authorizedProjectScope, requireSameOrigin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const requestedProjectId = new URL(request.url).searchParams.get("projectId")?.trim();
    authorizedProjectScope(identity, "case_source.manage", requestedProjectId || undefined);
    const services = await getPlatformServices();
    const upload = await readJarUpload(request, services.config.maxJarBytes);
    const inspection = await services.discovery.inspect(upload.fileName, upload.content);
    return NextResponse.json(inspection);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
