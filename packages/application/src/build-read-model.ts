import { PublicPlatformStatisticsService } from "./read-public-statistics";
import { buildBatchComparisonSnapshot } from "./build-batch-comparison-snapshot";
import {
  caseDirectoryPartSchema,
  batchCountersSnapshotSchema,
  executionCaseKeysSchema,
  suiteDirectoryPartSchema,
  sourcePreviewSchema,
  executionOverviewSnapshotSchema,
  ddtDashboardSnapshotSchema,
  analyticsSummarySchema,
  caseSuiteActivitySummarySchema,
  failureAnalysisBatchPageSchema,
  failureAnalysisBatchSchema,
  failureAnalysisStatisticsPageSchema,
} from "@autoforge/contracts";
import type {
  RunBatchRepository,
  CaseSuiteRepository,
  PlatformStatisticsRepository,
  CaseCatalogRepository,
  Clock,
  DdtRepository,
  FailureAnalysisRepository,
  PlatformOperationsRepository,
} from "./ports";
import type { DashboardSnapshotService } from "./dashboard-snapshots";
import type { CaseSuiteActivityService } from "./read-case-suite-activity";
import type { ReadModelBuilder } from "./read-model-snapshots";

export function createReadModelBuilder(dependencies: {
  catalog: CaseCatalogRepository;
  batches: RunBatchRepository;
  suites: CaseSuiteRepository;
  statistics: PlatformStatisticsRepository;
  ddt: DdtRepository;
  operations: PlatformOperationsRepository;
  dashboard: DashboardSnapshotService;
  suiteActivity: CaseSuiteActivityService;
  analysis: FailureAnalysisRepository;
  clock: Clock;
}): ReadModelBuilder {
  return async (query, writePart) => {
    switch (query.kind) {
      case "execution_case_page": {
        const page = await dependencies.batches.listCasePage({
          batchId: query.batchId,
          projectIds: [query.projectId],
          scope: query.filter.scope,
          sort: query.filter.sort,
          direction: query.filter.direction,
          offset: query.filter.offset,
          limit: query.filter.limit,
          ...(query.filter.status ? { status: query.filter.status } : {}),
          ...(query.filter.query ? { query: query.filter.query } : {}),
        });
        if (!page) return null;
        return executionCaseKeysSchema.parse({
          keys: page.items.map((item) => ({
            runId: item.run.id,
            ...(item.attempt ? { attemptId: item.attempt.id } : {}),
            round: item.round,
          })),
          total: page.total,
        });
      }
      case "batch_counters": {
        const counters = [];
        for (const reference of query.batches) {
          const batch = await dependencies.batches.getSummary(reference.id, [reference.projectId]);
          if (batch) counters.push(batch);
        }
        return batchCountersSnapshotSchema.parse(counters);
      }
      case "source_preview": {
        const source = await dependencies.catalog.getSource(query.sourceId, [query.projectId]);
        if (!source) return null;
        return sourcePreviewSchema.parse({
          ...source.inspection,
          testNgXmlSelections: undefined,
          classes: source.inspection.classes.length <= 100 ? source.inspection.classes : [],
        });
      }
      case "public_statistics":
        return new PublicPlatformStatisticsService(
          dependencies.statistics,
          dependencies.clock,
          60_000,
          query.refreshSeconds,
        ).read();
      case "analytics_scope":
        return analyticsSummarySchema.parse(
          await dependencies.operations.readAnalytics({
            filter: query.filter,
            ...(query.projectIds ? { projectIds: query.projectIds } : {}),
            generatedAt: dependencies.clock.now().toISOString(),
          }),
        );
      case "suite_directory": {
        const suite = await dependencies.suites.getSummary(query.suiteId, [query.projectId]);
        if (!suite) return null;
        let afterCaseMemberId: string | undefined;
        let afterDdtMemberId: string | undefined;
        let partCount = 0;
        let caseCount = 0;
        for (;;) {
          const page = await dependencies.suites.listMemberPage({
            suiteId: query.suiteId,
            projectIds: [query.projectId],
            limit: 250,
            ...(afterCaseMemberId ? { afterCaseMemberId } : {}),
            ...(afterDdtMemberId ? { afterDdtMemberId } : {}),
          });
          if (!page || (!page.items.length && !page.ddtItems.length)) break;
          // Member trees need names and method counts; DDT cells and TestNG metadata stay in their detail endpoints.
          await writePart(
            partCount++,
            suiteDirectoryPartSchema.parse({
              items: page.items.map((item) => ({
                ...item,
                caseDefinition: {
                  ...item.caseDefinition,
                  methodCount: item.caseDefinition.methods.length,
                },
              })),
              ddtItems: page.ddtItems,
            }),
          );
          caseCount += page.items.length + page.ddtItems.length;
          afterCaseMemberId = page.items.at(-1)?.id ?? afterCaseMemberId;
          afterDdtMemberId = page.ddtItems.at(-1)?.id ?? afterDdtMemberId;
        }
        return { partCount, caseCount, revision: suite.revision };
      }
      case "execution_overview": {
        const overview = await dependencies.batches.getDetailOverview(query.batchId, [
          query.projectId,
        ]);
        if (!overview) return null;
        const { batch, ...statistics } = overview;
        return executionOverviewSnapshotSchema.parse({
          ...statistics,
          sourceVersion: batch.version,
          counters: {
            queuedRuns: batch.queuedRuns,
            assignedRuns: batch.assignedRuns,
            runningRuns: batch.runningRuns,
            succeededRuns: batch.succeededRuns,
            failedRuns: batch.failedRuns,
            timedOutRuns: batch.timedOutRuns,
            cancelledRuns: batch.cancelledRuns,
          },
          sourceStatus: batch.status,
        });
      }
      case "batch_comparison":
        return buildBatchComparisonSnapshot(dependencies.batches, query, writePart);
      case "dashboard":
        return dependencies.dashboard.refresh(query);
      case "analytics":
        return analyticsSummarySchema.parse(
          await dependencies.operations.readAnalytics({
            filter: {
              ...query.filter,
              projectId: query.projectId,
              projectVersionId: query.projectVersionId,
            },
            projectIds: [query.projectId],
            generatedAt: dependencies.clock.now().toISOString(),
          }),
        );
      case "suite_activity":
        return caseSuiteActivitySummarySchema.parse(
          await dependencies.suiteActivity.readSummary(query, query.suiteIds),
        );
      case "analysis_batches":
        return failureAnalysisBatchPageSchema.parse(
          await dependencies.analysis.listBatches({
            projectId: query.projectId,
            ...(query.projectVersionId ? { projectVersionId: query.projectVersionId } : {}),
            view: query.view,
            limit: query.limit,
            ...(query.cursor ? { cursor: query.cursor } : {}),
          }),
        );
      case "analysis_batch": {
        const projectVersionId =
          query.projectVersionId ??
          (await dependencies.batches.getSummary(query.batchId, [query.projectId]))?.policy
            ?.projectVersionId;
        if (!projectVersionId) return null;
        const batch = await dependencies.analysis.getBatch({
          projectId: query.projectId,
          batchId: query.batchId,
          projectVersionId,
        });
        return batch === null ? null : failureAnalysisBatchSchema.parse(batch);
      }
      case "analysis_statistics":
        return failureAnalysisStatisticsPageSchema.parse(
          await dependencies.analysis.readStatistics({
            projectId: query.projectId,
            ...(query.projectVersionId ? { projectVersionId: query.projectVersionId } : {}),
            batchId: query.batchId,
            limit: query.limit,
            ...(query.cursor ? { cursor: query.cursor } : {}),
            generatedAt: dependencies.clock.now().toISOString(),
          }),
        );
      case "ddt_dashboard":
        return ddtDashboardSnapshotSchema.parse(await dependencies.ddt.dashboard(query));
      case "case_directory": {
        let cursor: string | undefined;
        let partCount = 0;
        let caseCount = 0;
        const visitedCursors = new Set<string>();
        do {
          const page = await dependencies.catalog.listCases({
            projectIds: [query.projectId],
            projectVersionId: query.projectVersionId,
            testStageId: query.testStageId,
            scopedOnly: true,
            limit: 250,
            ...(cursor ? { cursor } : {}),
          });
          const outcomes = await dependencies.catalog.listLatestRunOutcomes(
            page.items.map((item) => item.id),
          );
          await writePart(
            partCount,
            caseDirectoryPartSchema.parse({ items: page.items, outcomes }),
          );
          partCount += 1;
          caseCount += page.items.length;
          if (page.nextCursor && visitedCursors.has(page.nextCursor))
            throw new Error("Case snapshot pagination repeated a cursor.");
          cursor = page.nextCursor;
          if (cursor) visitedCursors.add(cursor);
        } while (cursor);
        return { caseCount, partCount };
      }
    }
  };
}
