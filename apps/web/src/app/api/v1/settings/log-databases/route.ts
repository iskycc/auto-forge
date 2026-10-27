import { registerLogDatabaseSchema, logDatabaseSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { requireLogDatabases } from "@/lib/log-databases";

export async function GET(request: Request) {
  const currentRequestId = requestId(request);
  try {
    await authorizeRequest(request, "settings.read", undefined);
    const { logDatabases } = await requireLogDatabases();
    const cursor = new URL(request.url).searchParams.get("cursor");
    return NextResponse.json(
      await logDatabases.list(cursor ? logDatabaseSchema.shape.id.parse(cursor) : undefined),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function POST(request: Request) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    const input = registerLogDatabaseSchema.parse(await readJsonBody(request, 8192));
    const { services, logDatabases } = await requireLogDatabases();
    const saved = await logDatabases.register(input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "platform.log_database_registered",
      resourceType: "log_database",
      resourceId: saved.id,
      requestId: currentRequestId,
      details: { name: saved.name, address: saved.address },
    });
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
