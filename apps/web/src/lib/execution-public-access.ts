import "server-only";

import type { IdentityAccessService, PublicExecutionAccessService } from "@autoforge/application";
import { DomainError } from "@autoforge/domain";
import { z } from "zod";
import { authenticateRequest } from "./auth";
import {
  executionShareAccess,
  executionShareQuerySchema,
  hasExecutionShareAccess,
  type ExecutionShareAccess,
} from "./execution-share-query";
import { readPermanentShareToken } from "./permanent-share-token";

type ExecutionReadServices = {
  config: { masterKey: string };
  identityAccess: Pick<IdentityAccessService, "projectScope">;
  publicExecutionAccess: Pick<PublicExecutionAccessService, "isBatchPublic">;
};

/** Public reads require a persisted publication grant or a valid legacy signature. */
export async function executionReadProjectScope(
  request: Request,
  batchId: string,
  access: ExecutionShareAccess,
  services: ExecutionReadServices,
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

const attemptShareQuerySchema = executionShareQuerySchema.extend({
  batchId: z.string().min(1).max(128).optional(),
});

export async function authorizeAttemptRead(
  request: Request,
  attemptId: string,
  permission: "log.read" | "run.read",
  services: ExecutionReadServices & {
    publicExecutionAccess: Pick<
      PublicExecutionAccessService,
      "isBatchPublic" | "assertAttemptInBatch"
    >;
  },
): Promise<{ actorId: string; projectIds?: readonly string[] | undefined; shared: boolean }> {
  const query = attemptShareQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  const access = executionShareAccess(query);
  if (hasExecutionShareAccess(access)) {
    if (!query.batchId)
      throw new DomainError("RUN_BATCH_SHARE_TOKEN_INVALID", "执行详情公开访问链接无效。");
    await executionReadProjectScope(request, query.batchId, access, services);
    await services.publicExecutionAccess.assertAttemptInBatch(query.batchId, attemptId);
    return { actorId: "public-execution", shared: true };
  }
  const identity = await authenticateRequest(request);
  return {
    actorId: identity.user.id,
    projectIds: services.identityAccess.projectScope(identity, permission),
    shared: false,
  };
}
