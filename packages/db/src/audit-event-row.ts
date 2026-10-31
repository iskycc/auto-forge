import type { AuditEvent } from "@autoforge/domain";

export function auditEventRow(event: AuditEvent) {
  return {
    id: event.id,
    actorType: event.actorType,
    actorId: event.actorId ?? null,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId ?? null,
    projectId: event.projectId ?? null,
    result: event.result,
    requestId: event.requestId ?? null,
    detailsJson: JSON.stringify(event.details),
    recordedAt: event.recordedAt,
  };
}
