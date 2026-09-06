import {
  buildCaseDirectorySnapshot,
  buildSuiteDirectorySnapshot,
} from "./build-directory-snapshots";
import { PublicPlatformStatisticsService } from "./read-public-statistics";
import { buildBatchComparisonSnapshot } from "./build-batch-comparison-snapshot";
import {
  batchCountersSnapshotSchema,
  executionCaseKeysSchema,
  sourcePreviewSchema,
  sourceDirectoryPartSchema,
  DIRECTORY_CHUNK_SIZE,
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
      case "source_directory": {
        const source = await dependencies.catalog.getSource(query.sourceId, [query.projectId]);
        if (!source) return null;
        let partCount = 0;
        for (
          let offset = 0;
          offset < source.inspection.classes.length;
          offset += DIRECTORY_CHUNK_SIZE
        ) {
          await writePart(
            partCount++,
            sourceDirectoryPartSchema.parse(
              source.inspection.classes.slice(offset, offset + DIRECTORY_CHUNK_SIZE),
            ),
          );
        }
        return { caseCount: source.inspection.classes.length, partCount };
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
      case "suite_directory":
        return buildSuiteDirectorySnapshot(dependencies.suites, query, writePart);
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
      case "case_directory":
        return buildCaseDirectorySnapshot(
          dependencies.catalog,
          dependencies.suites,
          query,
          writePart,
        );
    }
  };
}
