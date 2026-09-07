import { auditListQuerySchema } from "@autoforge/contracts";
import { auditCsv } from "@/lib/audit-presentation";
import { NextResponse } from "next/server";
import { z } from "zod";

import { authenticateRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

const exportQuerySchema = auditListQuerySchema.omit({ cursor: true, limit: true }).extend({
  maximumEvents: z.coerce.number().int().min(1).max(5_000).default(1_000),
});

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const input = exportQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const events = await (
      await getPlatformServices()
    ).identityAccess.exportAudit(identity, {
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.resourceType ? { resourceType: input.resourceType } : {}),
      ...(input.result ? { result: input.result } : {}),
      ...(input.recordedAfter ? { recordedAfter: input.recordedAfter } : {}),
      ...(input.recordedBefore ? { recordedBefore: input.recordedBefore } : {}),
      maximumEvents: input.maximumEvents,
    });
    return new NextResponse(auditCsv(events), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="autoforge-audit.csv"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
