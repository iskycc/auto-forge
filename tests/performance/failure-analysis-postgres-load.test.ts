import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { createPostgresDatabase, PostgresFailureAnalysisRepository } from "@autoforge/db/postgres";
import { describe, expect, it } from "vitest";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const RUN_COUNT = 100_000;
const PROJECT_ID = "00000000-0000-7000-8000-000000000001";
const VERSION_ID = "failure-analysis-postgres-load-version";
const RECORDED_AT = "2026-09-01T00:00:00.000Z";

if (!connectionString) {
  describe.skip("PostgreSQL failure analysis performance", () => {
    it("requires AUTOFORGE_TEST_POSTGRES_URL", () => undefined);
  });
} else {
  describe("PostgreSQL failure analysis performance", () => {
    it(`keeps bounded reads and 100-row completion fast with ${RUN_COUNT.toLocaleString()} failures`, async () => {
      const suffix = randomUUID();
      const schemaName = `autoforge_failure_perf_${suffix.replaceAll("-", "")}`;
      const suiteId = `failure-analysis-load-suite-${suffix}`;
      const runnerId = `failure-analysis-load-runner-${suffix}`;
      const batchId = `failure-analysis-load-batch-${suffix}`;
      const migrationsFolder = resolve(import.meta.dirname, "../../packages/db/drizzle/postgresql");
      const adminHandle = createPostgresDatabase({
        connectionString,
        migrationsFolder,
      });
      let handle: ReturnType<typeof createPostgresDatabase> | undefined;
      let schemaCreated = false;
      try {
        await adminHandle.ready;
        await adminHandle.pool.query(`CREATE SCHEMA ${schemaName}`);
        schemaCreated = true;
        const scopedConnection = new URL(connectionString);
        scopedConnection.searchParams.set("options", `-c search_path=${schemaName}`);
        handle = createPostgresDatabase({
          connectionString: scopedConnection.toString(),
          migrationsFolder,
        });
        await handle.ready;
        await handle.pool.query(
          `INSERT INTO case_suites
            (id,project_id,name,description,version,status,enabled,revision,policy_json,created_at,updated_at)
           VALUES ($1,$2,'性能分析任务','',1,'active',TRUE,1,'{}',$3,$3)`,
          [suiteId, PROJECT_ID, RECORDED_AT],
        );
        await handle.pool.query(
          `INSERT INTO runners
            (id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,
             labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at)
           VALUES ($1,'hash','性能 Runner',FALSE,FALSE,'linux','amd64','1.0.0',1,
                   '[]','[]',100,0,$2,$2,$2)`,
          [runnerId, RECORDED_AT],
        );
        await handle.pool.query(
          `INSERT INTO run_batches
            (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,batch_kind,
             environment_json,total_runs,current_round,project_id,policy_json,created_at,updated_at)
           VALUES ($1,9001,$2,'性能分析任务',1,'succeeded',0,'standard','[]',$3,1,$4,$5,$6,$6)`,
          [
            batchId,
            suiteId,
            RUN_COUNT,
            PROJECT_ID,
            JSON.stringify({ projectVersionId: VERSION_ID }),
            RECORDED_AT,
          ],
        );
        await handle.pool.query(
          `INSERT INTO execution_runs
            (id,batch_id,case_definition_id,case_version,display_name,class_name,status,
             attempt_count,terminal_outcome,created_at,updated_at)
           SELECT 'analysis-run-' || LPAD(value::text,6,'0'),$1,
                  'analysis-case-' || LPAD(value::text,6,'0'),1,
                  'Failure case ' || LPAD(value::text,6,'0'),
                  'load.analysis.Case' || LPAD(value::text,6,'0'),
                  'failed',1,'failed',$2,$2
           FROM generate_series(0,$3 - 1) AS value`,
          [batchId, RECORDED_AT, RUN_COUNT],
        );
        await handle.pool.query(
          `INSERT INTO run_attempts
            (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,
             result_code,result_summary,created_at,finished_at)
           SELECT 'analysis-attempt-' || LPAD(value::text,6,'0'),
                  'analysis-run-' || LPAD(value::text,6,'0'),$1,1,'failed',1,'failed',
                  'TESTNG_RESULT','java.lang.AssertionError: needle-' || value,$2,$2
           FROM generate_series(0,$3 - 1) AS value`,
          [runnerId, RECORDED_AT, RUN_COUNT],
        );
        const repository = new PostgresFailureAnalysisRepository(handle);
        await repository.startBatch({
          projectId: PROJECT_ID,
          projectVersionId: VERSION_ID,
          batchId: batchId,
          startedBy: "load-analyst",
          startedAt: RECORDED_AT,
        });

        const homeStartedAt = performance.now();
        const batches = await repository.listBatches({
          projectId: PROJECT_ID,
          projectVersionId: VERSION_ID,
          limit: 24,
        });
        const homeDurationMs = performance.now() - homeStartedAt;
        expect(batches.items[0]).toMatchObject({ id: batchId, failedRuns: RUN_COUNT });
        expect(homeDurationMs).toBeLessThan(2_000);
        recordMetric("postgres-failure-analysis-home", homeDurationMs, { runs: RUN_COUNT });
        for (const sort of [
          "class_path",
          "case_name",
          "failure_summary",
          "claim_status",
        ] as const) {
          const candidatesStartedAt = performance.now();
          const candidates = await repository.listCandidates({
            projectId: PROJECT_ID,
            projectVersionId: VERSION_ID,
            batchId,
            sort,
            direction: "asc",
            limit: 50,
          });
          const candidatesDurationMs = performance.now() - candidatesStartedAt;
          expect(candidates?.items).toHaveLength(50);
          expect(candidatesDurationMs).toBeLessThan(2_000);
          recordMetric(`postgres-failure-analysis-sort-${sort}`, candidatesDurationMs, {
            runs: RUN_COUNT,
          });
        }

        const searchStartedAt = performance.now();
        const search = await repository.listCandidates({
          projectId: PROJECT_ID,
          projectVersionId: VERSION_ID,
          batchId,
          query: "needle-99999",
          sort: "failure_summary",
          direction: "asc",
          limit: 50,
        });
        const searchDurationMs = performance.now() - searchStartedAt;
        expect(search?.items).toHaveLength(1);
        expect(searchDurationMs).toBeLessThan(2_000);
        recordMetric("postgres-failure-analysis-search", searchDurationMs, { runs: RUN_COUNT });

        const executionRunIds = Array.from(
          { length: 100 },
          (_, index) => `analysis-run-${index.toString().padStart(6, "0")}`,
        );
        const claimStartedAt = performance.now();
        const claimed = await repository.claim({
          projectId: PROJECT_ID,
          projectVersionId: VERSION_ID,
          batchId,
          executionRunIds,
          claims: executionRunIds.map((executionRunId, index) => ({
            id: `analysis-claim-${suffix}-${index}`,
            executionRunId,
          })),
          claimantId: `performance-analyst-${suffix}`,
          claimantUsername: "performance-analyst",
          claimantDisplayName: "性能分析员",
          claimedAt: RECORDED_AT,
        });
        const claimDurationMs = performance.now() - claimStartedAt;
        const startStartedAt = performance.now();
        const started = await repository.start({
          analysisId: claimed.claims[0]!.id,
          projectId: PROJECT_ID,
          claimantId: `performance-analyst-${suffix}`,
          category: "code_issue_filed",
          startedAt: RECORDED_AT,
        });
        const startDurationMs = performance.now() - startStartedAt;
        const evidenceStartedAt = performance.now();
        const attached = await repository.attachScreenshot({
          analysisIds: claimed.claims.map((claim) => claim.id),
          projectId: PROJECT_ID,
          claimantId: `performance-analyst-${suffix}`,
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
        const proofLookupStartedAt = performance.now();
        const proofs = await repository.findSuccessfulManualRerunAttempts({
          analysisIds: claimed.claims.map((claim) => claim.id),
          projectId: PROJECT_ID,
          claimantId: `performance-analyst-${suffix}`,
        });
        const proofLookupDurationMs = performance.now() - proofLookupStartedAt;
        const completionStartedAt = performance.now();
        const completed = await repository.complete({
          analysisIds: claimed.claims.map((claim) => claim.id),
          projectId: PROJECT_ID,
          claimantId: `performance-analyst-${suffix}`,
          category: "code_issue_filed",
          issueDescription: "性能回归夹具",
          ticketReference: "PERF-1",
          rerunProofs: new Map(),
          completedAt: RECORDED_AT,
        });
        const completionDurationMs = performance.now() - completionStartedAt;
        expect(completed).toHaveLength(100);
        expect(started?.status).toBe("analyzing");
        expect(attached).toHaveLength(100);
        expect(proofs.size).toBe(0);
        expect(claimDurationMs).toBeLessThan(2_000);
        expect(startDurationMs).toBeLessThan(500);
        expect(evidenceDurationMs).toBeLessThan(500);
        expect(proofLookupDurationMs).toBeLessThan(500);
        expect(completionDurationMs).toBeLessThan(500);
        recordMetric("postgres-failure-analysis-claim", claimDurationMs, {
          selected: 100,
        });
        recordMetric("postgres-failure-analysis-complete", completionDurationMs, {
          selected: 100,
        });
        recordMetric("postgres-failure-analysis-start", startDurationMs, { selected: 1 });
        recordMetric("postgres-failure-analysis-evidence-metadata", evidenceDurationMs, {
          selected: 100,
        });
        recordMetric("postgres-failure-analysis-rerun-proof-lookup", proofLookupDurationMs, {
          selected: 100,
        });

        await handle.pool.query(
          `INSERT INTO failure_analysis_claims
            (id,project_id,batch_id,execution_run_id,case_definition_id,attempt_id,case_name,
             class_name,attempt_number,failure_summary,result_code,status,category,claimant_id,
             claimant_username,claimant_display_name,claimed_at,analysis_started_at,updated_at)
           SELECT 'bulk-claim-' || RIGHT(run.id,6),$1,run.batch_id,run.id,
                  run.case_definition_id,attempt.id,run.display_name,run.class_name,1,
                  attempt.result_summary,attempt.result_code,'claimed',NULL,$2,
                  'performance-analyst','性能分析员',$3,NULL,$3
           FROM execution_runs run
           JOIN run_attempts attempt ON attempt.execution_run_id=run.id AND attempt.attempt_number=1
           WHERE run.batch_id=$4 AND run.id>='analysis-run-000100'`,
          [PROJECT_ID, `performance-analyst-${suffix}`, RECORDED_AT, batchId],
        );
        const claimsStartedAt = performance.now();
        const claimsPage = await repository.listClaims({
          projectId: PROJECT_ID,
          projectVersionId: VERSION_ID,
          claimantId: `performance-analyst-${suffix}`,
          batchId,
          sort: "class_path",
          direction: "asc",
          limit: 50,
        });
        const claimsDurationMs = performance.now() - claimsStartedAt;
        expect(claimsPage.items).toHaveLength(50);
        expect(claimsPage.nextCursor).toBeTruthy();
        recordMetric("postgres-failure-analysis-claims-page", claimsDurationMs, {
          claims: RUN_COUNT,
        });

        const claimSearchStartedAt = performance.now();
        const searchedClaims = await repository.listClaims({
          projectId: PROJECT_ID,
          projectVersionId: VERSION_ID,
          claimantId: `performance-analyst-${suffix}`,
          batchId,
          query: "needle-99999",
          sort: "class_path",
          direction: "asc",
          limit: 50,
        });
        const claimSearchDurationMs = performance.now() - claimSearchStartedAt;
        expect(searchedClaims.items).toEqual([
          expect.objectContaining({ caseName: "Failure case 099999" }),
        ]);
        expect(claimSearchDurationMs).toBeLessThan(500);
        recordMetric("postgres-failure-analysis-claims-search", claimSearchDurationMs, {
          claims: RUN_COUNT,
        });
        expect(claimsDurationMs).toBeLessThan(500);
      } finally {
        await handle?.close();
        if (schemaCreated) await adminHandle.pool.query(`DROP SCHEMA ${schemaName} CASCADE`);
        await adminHandle.close();
      }
    });
  });
}

function recordMetric(name: string, durationMs: number, scale: Record<string, number>): void {
  process.stdout.write(
    `${JSON.stringify({ metric: name, durationMs: Math.round(durationMs), ...scale })}\n`,
  );
}
