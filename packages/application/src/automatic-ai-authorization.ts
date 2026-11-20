import {
  DomainError,
  executionServiceAccountId,
  isDomainError,
  type AuthenticatedIdentity,
} from "@autoforge/domain";
import type {
  IdentityAccessRepository,
  PlatformOperationsRepository,
  RunBatchRepository,
} from "./ports";
import { assertAiPermission, resolveAiActor } from "./ai-analysis";
import { normalizeIdentityUsername } from "./manage-identity-access";

type AutomaticAiAuthority = {
  actorLabel: "公开链接分享人" | "服务账号创建人" | "执行拉起人";
} & (
  | { actor: AuthenticatedIdentity; unavailableReason: null }
  | { actor: null; unavailableReason: string }
);

/** Public execution delegates automatic analysis to its sharer, without changing the initiator. */
export async function resolveAutomaticAiAuthority(
  identities: IdentityAccessRepository,
  batches: Pick<RunBatchRepository, "getMetadata">,
  batchId: string,
  options: {
    legacyInitiatorUsername?: string | null;
    serviceAccounts?: Pick<PlatformOperationsRepository, "findBatchServiceAccountPublisher">;
  } = {},
): Promise<AutomaticAiAuthority> {
  const batch = await batches.getMetadata(batchId);
  if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "自动初析的执行批次不存在。");
  const publisher = batch.publicExecution?.publisher;
  // Older records can have a username without the authentication-source column.
  const username = batch.requestedBy?.username ?? options.legacyInitiatorUsername;
  const serviceAccountId =
    !publisher && username && batch.requestedBy?.source !== "ldap"
      ? executionServiceAccountId(username)
      : undefined;
  // The authenticated publisher binds the service account to this batch. A similarly
  // named local user alone cannot delegate analysis to the account's creator.
  const serviceAccount =
    serviceAccountId && options.serviceAccounts
      ? await options.serviceAccounts.findBatchServiceAccountPublisher(batch.id, serviceAccountId)
      : null;
  const actorLabel = publisher
    ? "公开链接分享人"
    : serviceAccount
      ? "服务账号创建人"
      : "执行拉起人";
  // The immutable publisher ID survives renaming; never fall back to the initiator's grants.
  const credential =
    !publisher && !serviceAccount && username
      ? await identities.findUserByUsername(normalizeIdentityUsername(username))
      : null;
  const actorId = publisher?.id ?? serviceAccount?.creatorId ?? credential?.user.id;
  const actor = actorId ? await resolveAiActor(identities, actorId) : null;
  if (!actor)
    return {
      actor: null,
      actorLabel,
      unavailableReason:
        serviceAccount || publisher || username
          ? `自动初析未发起：${actorLabel}不存在或已禁用。`
          : "自动初析未发起：执行快照未记录可授权的拉起人。",
    };
  try {
    assertAiPermission(actor, batch.projectId, true);
  } catch (cause) {
    if (!isDomainError(cause) || cause.code !== "AUTH_FORBIDDEN") throw cause;
    return {
      actor: null,
      actorLabel,
      unavailableReason: `自动初析未发起：${actorLabel}缺少当前 AI 或证据权限。`,
    };
  }
  return { actor, actorLabel, unavailableReason: null };
}
