import { ddtScopeClearInputSchema, type DdtScopeClearPage } from "@autoforge/contracts";
import { DomainError, type DdtScope } from "@autoforge/domain";
import type { CaseSuiteRepository, Clock, DdtRepository, IdGenerator } from "./ports";

export type DdtScopeClearWrite = {
  scope: DdtScope;
  clearedBefore: string;
  updatedAt: string;
  actorId?: string;
  auditActorId: string;
  requestId: string;
  auditId: string;
  versionId: string;
};

export class DdtScopeClearService {
  constructor(
    private readonly cases: Pick<DdtRepository, "readScopeClearCounts" | "clearScopePage">,
    private readonly suites: Pick<CaseSuiteRepository, "unlinkDdtScopePage">,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async preview(scope: DdtScope) {
    const clearedBefore = this.clock.now().toISOString();
    return { ...(await this.cases.readScopeClearCounts(scope, clearedBefore)), clearedBefore };
  }

  async clearPage(
    scope: DdtScope,
    input: unknown,
    actor: { userId?: string; principalId: string },
    requestId: string,
  ): Promise<DdtScopeClearPage> {
    const options = ddtScopeClearInputSchema.parse(input);
    const now = this.clock.now();
    if (Date.parse(options.clearedBefore) > now.getTime())
      throw new DomainError("VALIDATION_FAILED", "清空范围时间无效，请重新确认清空范围。");
    const write: DdtScopeClearWrite = {
      scope,
      clearedBefore: new Date(options.clearedBefore).toISOString(),
      updatedAt: now.toISOString(),
      ...(actor.userId ? { actorId: actor.userId } : {}),
      auditActorId: actor.principalId,
      requestId,
      auditId: this.ids.next(),
      versionId: this.ids.next(),
    };
    const removedMembers = await this.suites.unlinkDdtScopePage(write);
    if (removedMembers)
      return {
        phase: "tasks",
        removedMembers,
        deletedHistory: 0,
        deletedCases: 0,
        deletedRecycled: 0,
        hasMore: true,
      };
    return this.cases.clearScopePage(write);
  }
}
