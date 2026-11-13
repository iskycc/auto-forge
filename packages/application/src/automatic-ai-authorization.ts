import { DomainError, isDomainError, type AuthenticatedIdentity } from "@autoforge/domain";
import type { IdentityAccessRepository, RunBatchRepository } from "./ports";
import { assertAiPermission, resolveAiActor } from "./ai-analysis";
import { normalizeIdentityUsername } from "./manage-identity-access";

type AutomaticAiAuthority = {
  actorLabel: "公开链接分享人" | "执行拉起人";
} & (
  | { actor: AuthenticatedIdentity; unavailableReason: null }
  | { actor: null; unavailableReason: string }
);

/** Public execution delegates automatic analysis to its sharer, without changing the initiator. */
export async function resolveAutomaticAiAuthority(
  identities: IdentityAccessRepository,
  batches: Pick<RunBatchRepository, "getMetadata">,
  batchId: string,
  legacyInitiatorUsername?: string | null,
): Promise<AutomaticAiAuthority> {
  const batch = await batches.getMetadata(batchId);
  if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "自动初析的执行批次不存在。");
  const publisher = batch.publicExecution?.publisher;
  const actorLabel = publisher ? "公开链接分享人" : "执行拉起人";
  // Older records can have a username without the authentication-source column.
  const username = batch.requestedBy?.username ?? legacyInitiatorUsername;
  // The immutable publisher ID survives renaming; never fall back to the initiator's grants.
  const credential =
    !publisher && username
      ? await identities.findUserByUsername(normalizeIdentityUsername(username))
      : null;
  const actorId = publisher?.id ?? credential?.user.id;
  const actor = actorId ? await resolveAiActor(identities, actorId) : null;
  if (!actor)
    return {
      actor: null,
      actorLabel,
      unavailableReason: publisher
        ? "自动初析未发起：公开链接分享账号不存在或已禁用。"
        : username
          ? "自动初析未发起：执行拉起账号不存在或已禁用。"
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
