import { NextResponse } from "next/server";
import { z } from "zod";
import { createLogArchiveSchema } from "@autoforge/contracts";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
export async function GET(request: Request) {
  const id = requestId(request);
  try {
    const identity = await authorizeRequest(request, "settings.read", undefined);
    const cursor = new URL(request.url).searchParams.get("cursor");
    const services = await getPlatformServices();
    return NextResponse.json(
      await services.logArchives.list(
        cursor ? z.string().uuid().parse(cursor) : undefined,
        identity.user.id,
      ),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}
export async function POST(request: Request) {
  const id = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    await authorizeRequest(request, "log.read", undefined);
    const input = createLogArchiveSchema.parse(await readJsonBody(request, 2048));
    const services = await getPlatformServices();
    const saved = await services.logArchives.create(input, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "platform.log_archive_created",
      resourceType: "log_archive",
      resourceId: saved.id,
      requestId: id,
      details: { month: saved.month },
    });
    return NextResponse.json(saved, { status: 202 });
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}
