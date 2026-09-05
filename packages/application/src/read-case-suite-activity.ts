import {
  caseSuiteActivityScopeSchema,
  caseSuiteActivitySummarySchema,
  caseSuiteRecentExecutionsSchema,
  type CaseSuiteActivityScope,
  type CaseSuiteActivitySummary,
  type CaseSuiteExecutionStatistics,
  type CaseSuiteRecentExecutions,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

import type { CaseSuiteRepository, Clock, RunBatchRepository } from "./ports";

const STATISTICS_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const MAXIMUM_SUITE_COUNT = 200;
const RECENT_EXECUTION_LIMIT = 10;

export type CaseSuiteStatisticsQuery = CaseSuiteActivityScope & {
  suiteIds: readonly string[];
  windowStartedAt: string;
  generatedAt: string;
};

export interface CaseSuiteActivityRepository {
  readStatistics(input: CaseSuiteStatisticsQuery): Promise<CaseSuiteExecutionStatistics[]>;
}

export class CaseSuiteActivityService {
  constructor(
    private readonly activity: CaseSuiteActivityRepository,
    private readonly suites: Pick<CaseSuiteRepository, "getSummary">,
    private readonly batches: Pick<RunBatchRepository, "listPage">,
    private readonly clock: Clock,
  ) {}

  async readSummary(
    scope: CaseSuiteActivityScope,
    requestedSuiteIds: readonly string[],
  ): Promise<CaseSuiteActivitySummary> {
    const validatedScope = caseSuiteActivityScopeSchema.parse(scope);
    const suiteIds = [...new Set(requestedSuiteIds)];
    if (suiteIds.length > MAXIMUM_SUITE_COUNT) {
      throw new DomainError("CASE_SUITE_SELECTION_INVALID", "一次最多读取 200 个任务的执行统计。");
    }
    const now = this.clock.now();
    const generatedAt = now.toISOString();
    const windowStartedAt = new Date(now.getTime() - STATISTICS_WINDOW_MS).toISOString();
    const statistics =
      suiteIds.length === 0
        ? []
        : await this.activity.readStatistics({
            ...validatedScope,
            suiteIds,
            windowStartedAt,
            generatedAt,
          });
    const bySuiteId = new Map(statistics.map((entry) => [entry.suiteId, entry]));
    return caseSuiteActivitySummarySchema.parse({
      generatedAt,
      windowStartedAt,
      items: suiteIds.map(
        (suiteId) =>
          bySuiteId.get(suiteId) ?? {
            suiteId,
            executionCount: 0,
            completedExecutionCount: 0,
            averagePassRate: null,
            averagePassedCases: null,
          },
      ),
    });
  }

  async readRecentExecutions(
    suiteId: string,
    scope: CaseSuiteActivityScope,
  ): Promise<CaseSuiteRecentExecutions> {
    const validatedScope = caseSuiteActivityScopeSchema.parse(scope);
    const suite = await this.suites.getSummary(suiteId, [validatedScope.projectId]);
    if (!suite || suite.policy.projectVersionId !== validatedScope.projectVersionId) {
      throw new DomainError("CASE_SUITE_NOT_FOUND", "指定项目版本下的用例任务不存在。");
    }
    const page = await this.batches.listPage({
      ...validatedScope,
      suiteId,
      limit: RECENT_EXECUTION_LIMIT,
    });
    return caseSuiteRecentExecutionsSchema.parse({
      items: page.items.map((batch) => ({
        id: batch.id,
        sequenceNumber: batch.sequenceNumber,
        status: batch.status,
        kind: batch.kind ?? "standard",
        totalRuns: batch.totalRuns,
        succeededRuns: batch.succeededRuns,
        failedRuns: batch.failedRuns,
        timedOutRuns: batch.timedOutRuns,
        cancelledRuns: batch.cancelledRuns,
        currentRound: batch.currentRound,
        retryLimit: batch.retryLimit,
        ...(batch.requestedBy ? { requestedBy: batch.requestedBy.username } : {}),
        ...(batch.terminationRequestedAt
          ? { terminationRequestedAt: batch.terminationRequestedAt }
          : {}),
        scheduledFor: batch.scheduledFor,
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt,
      })),
    });
  }
}
