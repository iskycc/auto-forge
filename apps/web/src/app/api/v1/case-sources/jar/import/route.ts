import { apiErrorResponse, readJarUpload } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "case_source.manage");
    const services = await getPlatformServices();
    const upload = await readJarUpload(request, services.config.maxJarBytes);
    const result = await services.importTestNgJar.execute(upload);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_source.import",
      resourceType: "case_source",
      resourceId: result.sourceId,
      requestId: currentRequestId,
      details: { duplicate: result.duplicate, fileName: upload.fileName },
    });
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
