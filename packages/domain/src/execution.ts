import { DomainError } from "./errors";

export type AssignmentStatus =
  "pending" | "claimed" | "running" | "completed" | "cancelled" | "expired";
export type LeaseStatus = "active" | "released" | "expired" | "revoked";
export type AttemptOutcome = "succeeded" | "failed" | "timed_out" | "cancelled";

const assignmentTransitions: Readonly<Record<AssignmentStatus, readonly AssignmentStatus[]>> = {
  pending: ["claimed", "cancelled", "expired"],
  claimed: ["running", "completed", "cancelled", "expired"],
  running: ["completed", "cancelled", "expired"],
  completed: [],
  cancelled: [],
  expired: [],
};

export function transitionAssignment(
  current: AssignmentStatus,
  next: AssignmentStatus,
): AssignmentStatus {
  if (current === next) return current;
  if (!assignmentTransitions[current].includes(next)) {
    throw new DomainError(
      "ASSIGNMENT_TRANSITION_INVALID",
      `Assignment cannot transition from ${current} to ${next}.`,
    );
  }
  return next;
}

export function assertActiveLease(input: {
  status: LeaseStatus;
  expiresAt: string;
  expectedVersion: number;
  actualVersion: number;
  now: string;
}): void {
  if (input.status !== "active") {
    throw new DomainError("LEASE_INACTIVE", `租约已失效（${input.status}）。`);
  }
  if (input.actualVersion !== input.expectedVersion) {
    throw new DomainError("LEASE_VERSION_CONFLICT", "租约版本已变化。");
  }
  if (input.expiresAt <= input.now) {
    throw new DomainError("LEASE_EXPIRED", "租约已过期。");
  }
}

export function outcomeAfterCompletion(input: {
  outcome: AttemptOutcome;
  attemptNumber: number;
  retryLimit: number;
  cancellationRequested: boolean;
}): { runStatus: "queued" | "succeeded" | "failed" | "cancelled"; retryScheduled: boolean } {
  if (input.outcome === "succeeded") return { runStatus: "succeeded", retryScheduled: false };
  if (input.outcome === "cancelled" || input.cancellationRequested) {
    return { runStatus: "cancelled", retryScheduled: false };
  }
  const retryScheduled = input.attemptNumber <= input.retryLimit;
  return { runStatus: retryScheduled ? "queued" : "failed", retryScheduled };
}

export function aggregateBatchStatus(
  statuses: readonly string[],
): "queued" | "dispatching" | "scheduled" | "running" | "succeeded" | "failed" | "cancelled" {
  if (statuses.length === 0) return "queued";
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.some((status) => status === "assigned")) {
    return statuses.some((status) => status === "queued") ? "dispatching" : "scheduled";
  }
  if (statuses.some((status) => status === "queued")) return "queued";
  if (statuses.every((status) => status === "succeeded")) return "succeeded";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  return "failed";
}
