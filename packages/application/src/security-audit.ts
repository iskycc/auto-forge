import { securityAuditAction } from "@autoforge/contracts";
import type { AuditEvent } from "@autoforge/domain";

export function securityAuditDetails(
  action: string,
  details: AuditEvent["details"],
  actorName?: string,
): AuditEvent["details"] {
  return {
    ...details,
    ...(actorName ? { actorName } : {}),
    eventDescription: securityAuditAction(action)?.label ?? "历史安全事件",
  };
}

export function describeSecurityAuditEvent(event: AuditEvent): AuditEvent {
  return { ...event, details: securityAuditDetails(event.action, event.details) };
}
