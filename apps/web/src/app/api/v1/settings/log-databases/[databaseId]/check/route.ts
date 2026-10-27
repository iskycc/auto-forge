import { logDatabaseSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { requireLogDatabases } from "@/lib/log-databases";

export async function POST(request: Request, context: { params: Promise<{ databaseId: string }> }) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    await authorizeRequest(request, "settings.manage", undefined);
    const id = logDatabaseSchema.shape.id.parse((await context.params).databaseId);
    const { services, logDatabases } = await requireLogDatabases();
    await logDatabases.check(id);
    return NextResponse.json({
      checkedAt: services.clock.now().toISOString(),
      message: "日志数据库连接与身份验证通过。",
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
