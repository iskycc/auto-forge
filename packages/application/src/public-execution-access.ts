import {
  publicCaseLogPath,
  publicExecutionPath,
  type SharedAttemptLogView,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

import type { AttemptLogShareService } from "./attempt-log-shares";
import { resolveAttemptSchedulingContexts } from "./attempt-scheduling-contexts";
import type {
  Clock,
  ExecutionControlRepository,
  PublicExecutionAccessRepository,
  RunBatchRepository,
} from "./ports";

/** Business IDs locate resources; persisted publication grants control anonymous access. */
export class PublicExecutionAccessService {
  constructor(
    private readonly access: PublicExecutionAccessRepository,
    private readonly batches: Pick<RunBatchRepository, "getMetadata">,
    private readonly executions: Pick<
      ExecutionControlRepository,
      | "resolveAttemptSchedulingContext"
      | "resolveAttemptSchedulingContexts"
      | "resolveAttemptProjectId"
    >,
    private readonly logs: Pick<AttemptLogShareService, "getSharedAttemptLogForBatch">,
    private readonly clock: Clock,
  ) {}

  async publishBatch(
    batchId: string,
    createdBy: string,
    projectIds?: readonly string[],
  ): Promise<string> {
    const batch = await this.batches.getMetadata(batchId, projectIds);
    if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
    await this.access.publishBatch({
      batchId,
      createdBy,
      createdAt: this.clock.now().toISOString(),
    });
    return publicExecutionPath(batchId);
  }

  isBatchPublic(batchId: string): Promise<boolean> {
    return this.access.isBatchPublic(batchId);
  }

  async readAttemptLog(
    anchorAttemptId: string,
    selectedAttemptId?: string,
  ): Promise<SharedAttemptLogView | null> {
    const context = await this.executions.resolveAttemptSchedulingContext(anchorAttemptId);
    if (!context) return null;
    const granted =
      (await this.access.isAttemptPublic(anchorAttemptId)) ||
      (await this.access.isBatchPublic(context.batchId));
    if (!granted) return null;
    return this.logs.getSharedAttemptLogForBatch(
      context.batchId,
      anchorAttemptId,
      selectedAttemptId,
    );
  }

  async ensureLinkForAttempt(
    attemptId: string,
    createdBy: string,
    projectIds?: readonly string[],
  ): Promise<string> {
    if (projectIds) {
      const projectId = await this.executions.resolveAttemptProjectId(attemptId);
      if (!projectId || !projectIds.includes(projectId))
        throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    }
    const links = await this.ensureLinksForAttempts([attemptId], createdBy);
    return links.get(attemptId)!;
  }

  ensureLinksForAttempts(
    attemptIds: readonly string[],
    createdBy: string,
  ): Promise<Map<string, string>> {
    return this.publishAttempts(attemptIds, createdBy);
  }

  ensureLinksForAttemptsInBatch(
    attemptIds: readonly string[],
    batchId: string,
    createdBy: string,
  ): Promise<Map<string, string>> {
    return this.publishAttempts(attemptIds, createdBy, batchId);
  }

  private async publishAttempts(
    attemptIds: readonly string[],
    createdBy: string,
    batchId?: string,
  ): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(attemptIds)];
    if (uniqueIds.length === 0) return new Map();
    const contexts = await resolveAttemptSchedulingContexts(this.executions, uniqueIds);
    if (
      contexts.size !== uniqueIds.length ||
      (batchId && [...contexts.values()].some((context) => context.batchId !== batchId))
    ) {
      throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在或不属于该批次。");
    }
    const createdAt = this.clock.now().toISOString();
    await this.access.publishAttempts(
      uniqueIds.map((attemptId) => ({ attemptId, createdBy, createdAt })),
    );
    return new Map(uniqueIds.map((attemptId) => [attemptId, publicCaseLogPath(attemptId)]));
  }
}
