import { auditListQuerySchema } from "@autoforge/contracts";
import type { AuditEvent } from "@autoforge/domain";
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
      ...(input.resourceType ? { resourceType: input.resourceType } : {}),
      ...(input.result ? { result: input.result } : {}),
      ...(input.recordedAfter ? { recordedAfter: input.recordedAfter } : {}),
      ...(input.recordedBefore ? { recordedBefore: input.recordedBefore } : {}),
      maximumEvents: input.maximumEvents,
    });
    return new NextResponse(toCsv(events), {
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

function toCsv(events: AuditEvent[]): string {
  const rows = events.map((event) =>
    [
      event.recordedAt,
      event.actorType,
      event.actorId ?? "",
      event.action,
      event.resourceType,
      event.resourceId ?? "",
      event.projectId ?? "",
      event.result,
      event.requestId ?? "",
      JSON.stringify(event.details),
    ]
      .map(csvCell)
      .join(","),
  );
  return [
    "recordedAt,actorType,actorId,action,resourceType,resourceId,projectId,result,requestId,details",
    ...rows,
  ].join("\n");
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
