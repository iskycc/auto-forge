import { selectLogDatabaseSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { requireLogDatabases } from "@/lib/log-databases";

export async function PUT(request: Request) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    const input = selectLogDatabaseSchema.parse(await readJsonBody(request, 4096));
    const { services, logDatabases } = await requireLogDatabases();
    await logDatabases.select(input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "platform.log_database_selected",
      resourceType: "log_database",
      resourceId: input.databaseId ?? "local",
      requestId: currentRequestId,
      details: { revision: input.revision + 1 },
    });
    return NextResponse.json({
      applied: true,
      message: "写入设置已生效，新批次使用所选存储；已有批次保持原存储。",
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
