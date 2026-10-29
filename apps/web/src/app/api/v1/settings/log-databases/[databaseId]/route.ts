import {
  logDatabaseSchema,
  registerLogDatabaseSchema,
  registerDailyLogServerSchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { requireLogDatabases } from "@/lib/log-databases";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ databaseId: string }> },
) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    const id = logDatabaseSchema.shape.id.parse((await context.params).databaseId);
    const input = registerDailyLogServerSchema
      .or(registerLogDatabaseSchema)
      .parse(await readJsonBody(request, 8192));
    const { services, logDatabases } = await requireLogDatabases();
    const saved = await logDatabases.updateConnection(id, input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "platform.log_database_connection_updated",
      resourceType: "log_database",
      resourceId: id,
      requestId: currentRequestId,
      details: { name: saved.name, address: saved.address },
    });
    return NextResponse.json({ applied: true });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
