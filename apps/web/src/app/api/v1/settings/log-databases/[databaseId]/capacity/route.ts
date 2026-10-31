import { NextResponse } from "next/server";
import { logDatabaseSchema, postgresStorageCapacitySchema } from "@autoforge/contracts";
import { authorizeRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { requireLogDatabases } from "@/lib/log-databases";

export async function GET(request: Request, context: { params: Promise<{ databaseId: string }> }) {
  const currentRequestId = requestId(request);
  try {
    await authorizeRequest(request, "settings.read", undefined);
    const id = logDatabaseSchema.shape.id.parse((await context.params).databaseId);
    const { logDatabases } = await requireLogDatabases();
    const capacity = postgresStorageCapacitySchema.parse(
      await logDatabases.storageCapacity(
        id,
        new URL(request.url).searchParams.get("refresh") === "1",
      ),
    );
    return NextResponse.json(capacity, { headers: { "Cache-Control": "private, no-store" } });
  } catch (cause) {
    return apiErrorResponse(cause, currentRequestId);
  }
}
