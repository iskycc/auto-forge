import "server-only";

import type { IdentityAccessService, PublicExecutionAccessService } from "@autoforge/application";
import { DomainError } from "@autoforge/domain";
import { authenticateRequest } from "./auth";
import { readPermanentShareToken } from "./permanent-share-token";

/** Public reads require a persisted publication grant or a valid legacy signature. */
export async function executionReadProjectScope(
  request: Request,
  batchId: string,
  access: { accessToken?: string | undefined; publicAccess?: boolean | undefined },
  services: {
    config: { masterKey: string };
    identityAccess: Pick<IdentityAccessService, "projectScope">;
    publicExecutionAccess: Pick<PublicExecutionAccessService, "isBatchPublic">;
  },
): Promise<readonly string[] | undefined> {
  if (access.accessToken) {
    if (
      readPermanentShareToken(services.config.masterKey, access.accessToken, "run_batch") !==
      batchId
    )
      throw new DomainError("RUN_BATCH_SHARE_TOKEN_INVALID", "执行详情公开访问链接无效。");
    return undefined;
  }
  if (access.publicAccess) {
    if (!(await services.publicExecutionAccess.isBatchPublic(batchId)))
      throw new DomainError("RUN_BATCH_SHARE_TOKEN_INVALID", "执行详情公开访问链接无效。");
    return undefined;
  }
  const identity = await authenticateRequest(request);
  return services.identityAccess.projectScope(identity, "run.read");
}
