import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { createSqliteDatabase, SqliteFailureAnalysisRepository } from "@autoforge/db/sqlite";
import { afterAll, describe, expect, it } from "vitest";

const RUN_COUNT = 100_000;
const PROJECT_ID = "00000000-0000-7000-8000-000000000001";
const VERSION_ID = "failure-analysis-load-version";
const BATCH_ID = "00000000-0000-4000-8000-0000000f0001";
const RECORDED_AT = "2026-09-01T00:00:00.000Z";
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("failure analysis performance", () => {
  it(`keeps list, search, claim and completion bounded for ${RUN_COUNT.toLocaleString()} failures`, async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-failure-analysis-load-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "autoforge.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../../packages/db/drizzle/sqlite"),
    });
    try {
      seedFailureAnalysisLoad(handle.client);
      const repository = new SqliteFailureAnalysisRepository(handle);

      const homeStartedAt = performance.now();
      const batches = await repository.listBatches({
        projectId: PROJECT_ID,
        projectVersionId: VERSION_ID,
        limit: 24,
      });
      const homeDurationMs = performance.now() - homeStartedAt;
      expect(batches.items[0]).toMatchObject({ id: BATCH_ID, failedRuns: RUN_COUNT });
      expect(homeDurationMs).toBeLessThan(2_000);
      recordMetric("failure-analysis-home", homeDurationMs, { runs: RUN_COUNT });

      for (const sort of ["class_path", "case_name", "failure_summary", "claim_status"] as const) {
        const pageStartedAt = performance.now();
        const firstPage = await repository.listCandidates({
          projectId: PROJECT_ID,
          projectVersionId: VERSION_ID,
          batchId: BATCH_ID,
          sort,
          direction: "asc",
          limit: 50,
        });
        const pageDurationMs = performance.now() - pageStartedAt;
        expect(firstPage?.items).toHaveLength(50);
        expect(firstPage?.nextCursor).toBeTruthy();
        expect(pageDurationMs).toBeLessThan(2_000);
        recordMetric(`failure-analysis-sort-${sort}`, pageDurationMs, { runs: RUN_COUNT });
      }

      const searchStartedAt = performance.now();
      const searchPage = await repository.listCandidates({
        projectId: PROJECT_ID,
        projectVersionId: VERSION_ID,
        batchId: BATCH_ID,
        query: "needle-99999",
        sort: "failure_summary",
        direction: "asc",
        limit: 50,
      });
      const searchDurationMs = performance.now() - searchStartedAt;
      expect(searchPage?.items).toHaveLength(1);
      expect(searchDurationMs).toBeLessThan(2_000);
      recordMetric("failure-analysis-search", searchDurationMs, { runs: RUN_COUNT });

      const executionRunIds = Array.from(
        { length: 100 },
        (_, index) => `analysis-run-${index.toString().padStart(6, "0")}`,
      );
      const claimStartedAt = performance.now();
      const claimed = await repository.claim({
        projectId: PROJECT_ID,
        projectVersionId: VERSION_ID,
        batchId: BATCH_ID,
        executionRunIds,
        claims: executionRunIds.map((executionRunId, index) => ({
          id: `analysis-claim-${index.toString().padStart(3, "0")}`,
          executionRunId,
        })),
        claimantId: "performance-analyst",
        claimantUsername: "performance-analyst",
        claimantDisplayName: "性能分析员",
        claimedAt: RECORDED_AT,
      });
      const claimDurationMs = performance.now() - claimStartedAt;
      expect(claimed.claims).toHaveLength(100);
      expect(claimDurationMs).toBeLessThan(2_000);
      recordMetric("failure-analysis-claim", claimDurationMs, { selected: 100 });

      const startStartedAt = performance.now();
      const started = await repository.start({
        analysisId: claimed.claims[0]!.id,
        projectId: PROJECT_ID,
        claimantId: "performance-analyst",
        category: "code_issue_filed",
        startedAt: RECORDED_AT,
      });
      const startDurationMs = performance.now() - startStartedAt;
      expect(started?.status).toBe("analyzing");
      expect(startDurationMs).toBeLessThan(500);
      recordMetric("failure-analysis-start", startDurationMs, { selected: 1 });

      const evidenceStartedAt = performance.now();
      const attached = await repository.attachScreenshot({
        analysisIds: claimed.claims.map((claim) => claim.id),
        projectId: PROJECT_ID,
        claimantId: "performance-analyst",
        screenshot: {
          objectKey: "projects/performance/evidence.png",
          fileName: "evidence.png",
          mediaType: "image/png",
          sizeBytes: 1024,
          sha256: "a".repeat(64),
        },
        updatedAt: RECORDED_AT,
      });
      const evidenceDurationMs = performance.now() - evidenceStartedAt;
      expect(attached).toHaveLength(100);
      expect(evidenceDurationMs).toBeLessThan(500);
      recordMetric("failure-analysis-evidence-metadata", evidenceDurationMs, { selected: 100 });

      const proofLookupStartedAt = performance.now();
      const proofs = await repository.findSuccessfulManualRerunAttempts({
        analysisIds: claimed.claims.map((claim) => claim.id),
        projectId: PROJECT_ID,
        claimantId: "performance-analyst",
      });
      const proofLookupDurationMs = performance.now() - proofLookupStartedAt;
      expect(proofs.size).toBe(0);
      expect(proofLookupDurationMs).toBeLessThan(500);
      recordMetric("failure-analysis-rerun-proof-lookup", proofLookupDurationMs, { selected: 100 });

      const completionStartedAt = performance.now();
      const completed = await repository.complete({
        analysisIds: claimed.claims.map((claim) => claim.id),
        projectId: PROJECT_ID,
        claimantId: "performance-analyst",
        category: "code_issue_filed",
        issueDescription: "性能回归夹具",
        ticketReference: "PERF-1",
        remark: "批量完成",
        rerunProofs: new Map(),
        completedAt: RECORDED_AT,
      });
      const completionDurationMs = performance.now() - completionStartedAt;
      expect(completed).toHaveLength(100);
      expect(completionDurationMs).toBeLessThan(500);
      recordMetric("failure-analysis-complete", completionDurationMs, { selected: 100 });

      handle.client.exec(`
        INSERT INTO failure_analysis_claims
          (id,project_id,batch_id,execution_run_id,case_definition_id,attempt_id,case_name,
           class_name,attempt_number,failure_summary,result_code,status,category,claimant_id,
           claimant_username,claimant_display_name,claimed_at,analysis_started_at,updated_at)
        SELECT 'bulk-claim-' || SUBSTR(run.id,-6),'${PROJECT_ID}',run.batch_id,run.id,
               run.case_definition_id,attempt.id,run.display_name,run.class_name,1,
               attempt.result_summary,attempt.result_code,'claimed',NULL,'performance-analyst',
               'performance-analyst','性能分析员','${RECORDED_AT}',NULL,'${RECORDED_AT}'
        FROM execution_runs run
        JOIN run_attempts attempt ON attempt.execution_run_id=run.id AND attempt.attempt_number=1
        WHERE run.batch_id='${BATCH_ID}' AND run.id>='analysis-run-000100'
      `);
      const claimsStartedAt = performance.now();
      const claimsPage = await repository.listClaims({
        projectId: PROJECT_ID,
        projectVersionId: VERSION_ID,
        claimantId: "performance-analyst",
        batchId: BATCH_ID,
        limit: 50,
      });
      const claimsDurationMs = performance.now() - claimsStartedAt;
      expect(claimsPage.items).toHaveLength(50);
      expect(claimsPage.nextCursor).toBeTruthy();
      expect(claimsDurationMs).toBeLessThan(500);
      recordMetric("failure-analysis-claims-page", claimsDurationMs, { claims: RUN_COUNT });
    } finally {
      handle.close();
    }
  });
});

function seedFailureAnalysisLoad(client: SqliteClient): void {
  client.pragma("foreign_keys = OFF");
  client.exec(`
    INSERT INTO case_suites
      (id,project_id,name,description,version,status,enabled,revision,policy_json,created_at,updated_at)
    VALUES ('failure-analysis-load-suite','${PROJECT_ID}','性能分析任务','',1,'active',1,1,
            '{}','${RECORDED_AT}','${RECORDED_AT}');
    INSERT INTO runners
      (id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,
       labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at)
    VALUES ('failure-analysis-load-runner','hash','性能 Runner',0,0,'linux','amd64','1.0.0',1,
            '[]','[]',100,0,'${RECORDED_AT}','${RECORDED_AT}','${RECORDED_AT}');
    INSERT INTO run_batches
      (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,batch_kind,
       environment_json,total_runs,current_round,project_id,policy_json,created_at,updated_at)
    VALUES ('${BATCH_ID}',9001,'failure-analysis-load-suite','性能分析任务',1,'succeeded',0,
            'standard','[]',${RUN_COUNT},1,'${PROJECT_ID}',
            '{"projectVersionId":"${VERSION_ID}"}','${RECORDED_AT}','${RECORDED_AT}');
  `);
  const insertRun = client.prepare(
    `INSERT INTO execution_runs
      (id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,
       terminal_outcome,created_at,updated_at)
     VALUES (?,'${BATCH_ID}',?,1,?,?,'failed',1,'failed','${RECORDED_AT}','${RECORDED_AT}')`,
  );
  const insertAttempt = client.prepare(
    `INSERT INTO run_attempts
      (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,result_code,
       result_summary,created_at,finished_at)
     VALUES (?,?,'failure-analysis-load-runner',1,'failed',1,'failed','TESTNG_RESULT',?,
             '${RECORDED_AT}','${RECORDED_AT}')`,
  );
  client.transaction(() => {
    for (let index = 0; index < RUN_COUNT; index += 1) {
      const suffix = index.toString().padStart(6, "0");
      const runId = `analysis-run-${suffix}`;
      insertRun.run(
        runId,
        `analysis-case-${suffix}`,
        `Failure case ${suffix}`,
        `load.analysis.Case${suffix}`,
      );
      insertAttempt.run(
        `analysis-attempt-${suffix}`,
        runId,
        `java.lang.AssertionError: needle-${index}`,
      );
    }
  })();
  client.pragma("foreign_keys = ON");
}

function recordMetric(name: string, durationMs: number, scale: Record<string, number>): void {
  process.stdout.write(
    `${JSON.stringify({ metric: name, durationMs: Math.round(durationMs), ...scale })}\n`,
  );
}

type SqliteClient = {
  exec(sql: string): unknown;
  pragma(statement: string): unknown;
  prepare(sql: string): { run(...parameters: unknown[]): unknown };
  transaction<T>(operation: () => T): () => T;
};
