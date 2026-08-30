import "server-only";

import type { SharedLogRerunAccess } from "@/components/shared-attempt-log-content";
import type { currentIdentity } from "@/lib/auth";
import type { getPlatformServices } from "@/lib/services";

export async function sharedLogRerunAccess(
  services: Awaited<ReturnType<typeof getPlatformServices>>,
  identity: Awaited<ReturnType<typeof currentIdentity>>,
  attemptId: string,
): Promise<SharedLogRerunAccess> {
  if (!identity) return "login";
  if (identity.user.forcePasswordChange) return "forbidden";
  let context: { projectId: string };
  try {
    context = await services.runBatches.getAttemptRerunContext(attemptId);
    services.identityAccess.authorize(identity, "log.read", context.projectId);
  } catch {
    return "forbidden";
  }
  try {
    services.identityAccess.authorize(identity, "run.create", context.projectId);
    return "allowed";
  } catch {
    return "read_only";
  }
}
