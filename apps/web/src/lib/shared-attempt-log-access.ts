import "server-only";
import { isDomainError, type Permission } from "@autoforge/domain";

import type { SharedLogRerunAccess } from "@/components/shared-attempt-log-content";
import type { currentIdentity } from "@/lib/auth";
import type { getPlatformServices } from "@/lib/services";

export async function sharedLogAccess(
  services: Awaited<ReturnType<typeof getPlatformServices>>,
  identity: Awaited<ReturnType<typeof currentIdentity>>,
  attemptId: string,
): Promise<{
  rerunAccess: SharedLogRerunAccess;
  canCancelRuns: boolean;
  canReadCaseDetails: boolean;
}> {
  if (!identity) return { rerunAccess: "login", canCancelRuns: false, canReadCaseDetails: false };
  if (identity.user.forcePasswordChange)
    return { rerunAccess: "forbidden", canCancelRuns: false, canReadCaseDetails: false };
  let context: { projectId: string };
  try {
    context = await services.runBatches.getAttemptRerunContext(attemptId);
  } catch (error) {
    if (
      !isDomainError(error) ||
      (!error.code.endsWith("_NOT_FOUND") && error.code !== "AUTH_FORBIDDEN")
    )
      throw error;
    return { rerunAccess: "forbidden", canCancelRuns: false, canReadCaseDetails: false };
  }
  const permitted = (permission: Permission): boolean => {
    try {
      services.identityAccess.authorize(identity, permission, context.projectId);
      return true;
    } catch (error) {
      if (!isDomainError(error) || error.code !== "AUTH_FORBIDDEN") throw error;
      return false;
    }
  };
  const canReadCaseDetails = permitted("case.read");
  if (!permitted("log.read"))
    return { rerunAccess: "forbidden", canCancelRuns: false, canReadCaseDetails };
  return {
    rerunAccess: permitted("run.retry") ? "allowed" : "read_only",
    canCancelRuns: permitted("run.cancel"),
    canReadCaseDetails,
  };
}
