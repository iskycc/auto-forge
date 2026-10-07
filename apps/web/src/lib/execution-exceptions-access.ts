import "server-only";

import type { IdentityAccessService } from "@autoforge/application";
import { DomainError } from "@autoforge/domain";
import { authenticateRequest } from "./auth";
import { readPermanentShareToken } from "./permanent-share-token";

/** Diagnostic reads and downloads share the same project or permanent-share boundary. */
export async function executionExceptionProjectScope(
  request: Request,
  batchId: string,
  accessToken: string | undefined,
  services: {
    config: { masterKey: string };
    identityAccess: Pick<IdentityAccessService, "projectScope">;
  },
): Promise<readonly string[] | undefined> {
  if (accessToken) {
    if (readPermanentShareToken(services.config.masterKey, accessToken, "run_batch") !== batchId)
      throw new DomainError("RUN_BATCH_SHARE_TOKEN_INVALID", "执行详情永久分享链接无效。");
    return undefined;
  }
  const identity = await authenticateRequest(request);
  return services.identityAccess.projectScope(identity, "run.read");
}
