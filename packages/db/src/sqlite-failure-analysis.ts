import type { FailureAnalysisRepository } from "@autoforge/application";
import type {
  FailureAnalysisBatchPage,
  FailureAnalysisCandidatePage,
  FailureAnalysisSort,
} from "@autoforge/contracts";

import { runSqliteWriteTransaction, type SqliteDatabaseHandle } from "./database";
import {
  decodeFailureAnalysisCandidateCursor,
  encodeFailureAnalysisCandidateCursor,
  FAILURE_ANALYSIS_SUMMARY_MAXIMUM_CHARACTERS,
  toFailureAnalysisCandidate,
  toFailureAnalysisClaim,
  type FailureAnalysisRow,
} from "./failure-analysis-shared";
import { decodeRunBatchCursor, encodeRunBatchCursor } from "./run-batch-list";

type BatchRow = {
  id: string;
  sequenceNumber: number;
  suiteName: string;
  currentRound: number;
  failedRuns: number;
  claimedRuns: number;
  completedRuns: number;
  createdAt: string;
};

export class SqliteFailureAnalysisRepository implements FailureAnalysisRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async listBatches(input: {
    projectId: string;
    projectVersionId?: string;
    cursor?: string;
    limit: number;
  }): Promise<FailureAnalysisBatchPage> {
    const cursor = decodeRunBatchCursor(input.cursor);
    const where = [
      "batch.project_id=?",
      "batch.status IN ('succeeded','failed','cancelled')",
      "batch.batch_kind='standard'",
      "EXISTS (SELECT 1 FROM case_suites suite WHERE suite.id=batch.suite_id)",
      `EXISTS (SELECT 1 FROM execution_runs run
               JOIN run_attempts attempt ON attempt.execution_run_id=run.id
                AND attempt.attempt_number=batch.current_round
               WHERE run.batch_id=batch.id AND run.terminal_outcome='failed'
                 AND COALESCE(attempt.outcome,attempt.status)='failed')`,
    ];
    const parameters: Array<string | number> = [input.projectId];
    if (input.projectVersionId) {
      where.push("json_extract(batch.policy_json, '$.projectVersionId')=?");
      parameters.push(input.projectVersionId);
    }
    if (cursor) {
      where.push("(batch.created_at<? OR (batch.created_at=? AND batch.id<?))");
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    parameters.push(input.limit + 1);
    const rows = this.handle.client
      .prepare(
        `SELECT batch.id,batch.sequence_number AS sequenceNumber,batch.suite_name AS suiteName,
                batch.current_round AS currentRound,
                (SELECT COUNT(*) FROM execution_runs run
                 JOIN run_attempts attempt ON attempt.execution_run_id=run.id
                  AND attempt.attempt_number=batch.current_round
                 WHERE run.batch_id=batch.id AND run.terminal_outcome='failed'
                   AND COALESCE(attempt.outcome,attempt.status)='failed') AS failedRuns,
                (SELECT COUNT(*) FROM failure_analysis_claims claim
                 WHERE claim.batch_id=batch.id) AS claimedRuns,
                (SELECT COUNT(*) FROM failure_analysis_claims claim
                 WHERE claim.batch_id=batch.id AND claim.status='completed') AS completedRuns,
                batch.created_at AS createdAt
         FROM run_batches batch WHERE ${where.join(" AND ")}
         ORDER BY batch.created_at DESC,batch.id DESC LIMIT ?`,
      )
      .all(...parameters) as BatchRow[];
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last
        ? { nextCursor: encodeRunBatchCursor({ createdAt: last.createdAt, id: last.id }) }
        : {}),
    };
  }

  async getBatch(input: Parameters<FailureAnalysisRepository["getBatch"]>[0]) {
    const row = this.handle.client
      .prepare(
        `SELECT batch.id,batch.sequence_number AS sequenceNumber,batch.suite_name AS suiteName,
                batch.current_round AS currentRound,
                (SELECT COUNT(*) FROM execution_runs run
                 JOIN run_attempts attempt ON attempt.execution_run_id=run.id
                  AND attempt.attempt_number=batch.current_round
                 WHERE run.batch_id=batch.id AND run.terminal_outcome='failed'
                   AND COALESCE(attempt.outcome,attempt.status)='failed') AS failedRuns,
                (SELECT COUNT(*) FROM failure_analysis_claims claim
                 WHERE claim.batch_id=batch.id) AS claimedRuns,
                (SELECT COUNT(*) FROM failure_analysis_claims claim
                 WHERE claim.batch_id=batch.id AND claim.status='completed') AS completedRuns,
                batch.created_at AS createdAt
         FROM run_batches batch
         WHERE batch.id=? AND batch.project_id=?
           AND json_extract(batch.policy_json, '$.projectVersionId')=?
           AND batch.status IN ('succeeded','failed','cancelled')
           AND batch.batch_kind='standard'
           AND EXISTS (SELECT 1 FROM case_suites suite WHERE suite.id=batch.suite_id)`,
      )
      .get(input.batchId, input.projectId, input.projectVersionId) as BatchRow | undefined;
    return row ?? null;
  }

  async listCandidates(input: {
    projectId: string;
    projectVersionId: string;
    batchId: string;
    query?: string;
    sort: FailureAnalysisSort;
    direction: "asc" | "desc";
    cursor?: string;
    limit: number;
  }): Promise<FailureAnalysisCandidatePage | null> {
    const sortExpression = sqliteCandidateSortExpression(input.sort);
    const cursor = decodeFailureAnalysisCandidateCursor(input.cursor, input.sort, input.direction);
    const where = [
      "batch.id=?",
      "batch.project_id=?",
      "json_extract(batch.policy_json, '$.projectVersionId')=?",
      "batch.status IN ('succeeded','failed','cancelled')",
      "batch.batch_kind='standard'",
      "EXISTS (SELECT 1 FROM case_suites suite WHERE suite.id=batch.suite_id)",
      "run.terminal_outcome='failed'",
      "COALESCE(attempt.outcome,attempt.status)='failed'",
    ];
    const parameters: Array<string | number> = [
      input.batchId,
      input.projectId,
      input.projectVersionId,
    ];
    if (input.query?.trim()) {
      where.push(
        `LOWER(run.class_name || ' ' || run.display_name || ' ' ||
          SUBSTR(COALESCE(attempt.result_summary,attempt.result_code,''),1,
                 ${FAILURE_ANALYSIS_SUMMARY_MAXIMUM_CHARACTERS})) LIKE ? ESCAPE '\\'`,
      );
      parameters.push(`%${escapeSqliteLike(input.query.trim().toLowerCase())}%`);
    }
    if (cursor) {
      const comparison = input.direction === "desc" ? "<" : ">";
      where.push(
        `(${sortExpression}${comparison}? OR (${sortExpression}=? AND run.id${comparison}?))`,
      );
      parameters.push(cursor.value, cursor.value, cursor.executionRunId);
    }
    parameters.push(input.limit + 1);
    const direction = input.direction === "desc" ? "DESC" : "ASC";
    const rows = this.handle.client
      .prepare(
        `SELECT claim.id AS analysisId,batch.project_id AS projectId,batch.id AS batchId,
                run.id AS executionRunId,run.case_definition_id AS caseDefinitionId,
                attempt.id AS attemptId,run.display_name AS caseName,run.class_name AS className,
                attempt.attempt_number AS attemptNumber,
                COALESCE(NULLIF(TRIM(SUBSTR(attempt.result_summary,1,
                  ${FAILURE_ANALYSIS_SUMMARY_MAXIMUM_CHARACTERS})),''),attempt.result_code,
                  '未提供失败堆栈。') AS failureSummary,
                attempt.result_code AS resultCode,claim.status AS analysisStatus,
                claim.category,claim.claimant_id AS claimantId,
                claim.claimant_username AS claimantUsername,
                claim.claimant_display_name AS claimantDisplayName,
                claim.claimed_at AS claimedAt,claim.analysis_started_at AS analysisStartedAt,
                claim.completed_at AS completedAt,claim.issue_description AS issueDescription,
                claim.case_fix_evidence AS caseFixEvidence,claim.ticket_reference AS ticketReference,
                claim.remark,claim.rerun_proof_attempt_id AS rerunProofAttemptId,
                claim.rerun_proof_url AS rerunProofUrl,
                claim.screenshot_object_key AS screenshotObjectKey,
                claim.screenshot_file_name AS screenshotFileName,
                claim.screenshot_media_type AS screenshotMediaType,
                claim.screenshot_size_bytes AS screenshotSizeBytes,
                claim.screenshot_sha256 AS screenshotSha256,
                claim.updated_at AS analysisUpdatedAt,${sortExpression} AS sortValue
         FROM run_batches batch JOIN execution_runs run ON run.batch_id=batch.id
         JOIN run_attempts attempt ON attempt.execution_run_id=run.id
          AND attempt.attempt_number=batch.current_round
         LEFT JOIN failure_analysis_claims claim ON claim.execution_run_id=run.id
         WHERE ${where.join(" AND ")}
         ORDER BY ${sortExpression} ${direction},run.id ${direction} LIMIT ?`,
      )
      .all(...parameters) as FailureAnalysisRow[];
    // 有数据的常规路径已经由主查询完整验证批次作用域，不再额外往返一次数据库。
    // 只有空结果时才区分“合法空页”与“不可见批次”。
    if (
      rows.length === 0 &&
      !this.batchExists(input.batchId, input.projectId, input.projectVersionId)
    ) {
      return null;
    }
    const hasMore = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toFailureAnalysisCandidate),
      ...(hasMore && last
        ? {
            nextCursor: encodeFailureAnalysisCandidateCursor({
              sort: input.sort,
              direction: input.direction,
              value: last.sortValue ?? "",
              executionRunId: last.executionRunId,
            }),
          }
        : {}),
    };
  }

  async claim(input: Parameters<FailureAnalysisRepository["claim"]>[0]) {
    return runSqliteWriteTransaction(this.handle, () => {
      const requestedIds = [...input.executionRunIds];
      const placeholders = requestedIds.map(() => "?").join(",");
      const eligibleRows = this.handle.client
        .prepare(
          `SELECT run.id AS executionRunId,run.case_definition_id AS caseDefinitionId,
                  run.display_name AS caseName,run.class_name AS className,
                  attempt.id AS attemptId,attempt.attempt_number AS attemptNumber,
                  COALESCE(NULLIF(TRIM(SUBSTR(attempt.result_summary,1,
                    ${FAILURE_ANALYSIS_SUMMARY_MAXIMUM_CHARACTERS})),''),attempt.result_code,
                    '未提供失败堆栈。') AS failureSummary,
                  attempt.result_code AS resultCode
           FROM run_batches batch JOIN execution_runs run ON run.batch_id=batch.id
           JOIN run_attempts attempt ON attempt.execution_run_id=run.id
            AND attempt.attempt_number=batch.current_round
           WHERE batch.id=? AND batch.project_id=? AND run.terminal_outcome='failed'
             AND json_extract(batch.policy_json, '$.projectVersionId')=?
             AND batch.status IN ('succeeded','failed','cancelled')
             AND batch.batch_kind='standard'
             AND EXISTS (SELECT 1 FROM case_suites suite WHERE suite.id=batch.suite_id)
             AND COALESCE(attempt.outcome,attempt.status)='failed'
             AND run.id IN (${placeholders})`,
        )
        .all(input.batchId, input.projectId, input.projectVersionId, ...requestedIds) as Array<{
        executionRunId: string;
        caseDefinitionId: string;
        caseName: string;
        className: string;
        attemptId: string;
        attemptNumber: number;
        failureSummary: string;
        resultCode: string | null;
      }>;
      const idsByRunId = new Map(input.claims.map((claim) => [claim.executionRunId, claim.id]));
      const insert = this.handle.client.prepare(
        `INSERT OR IGNORE INTO failure_analysis_claims
          (id,project_id,batch_id,execution_run_id,case_definition_id,attempt_id,case_name,
           class_name,attempt_number,failure_summary,result_code,status,category,claimant_id,
           claimant_username,claimant_display_name,claimed_at,analysis_started_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'claimed',NULL,?,?,?,?,NULL,?)`,
      );
      for (const row of eligibleRows) {
        insert.run(
          idsByRunId.get(row.executionRunId),
          input.projectId,
          input.batchId,
          row.executionRunId,
          row.caseDefinitionId,
          row.attemptId,
          row.caseName,
          row.className,
          row.attemptNumber,
          row.failureSummary,
          row.resultCode,
          input.claimantId,
          input.claimantUsername,
          input.claimantDisplayName,
          input.claimedAt,
          input.claimedAt,
        );
      }
      const claims = this.selectClaimsByExecutionRunIds(
        input.projectId,
        input.projectVersionId,
        input.batchId,
        requestedIds,
      ).map(toFailureAnalysisClaim);
      const availableToActor = new Set(
        claims
          .filter((claim) => claim.claimantId === input.claimantId)
          .map((claim) => claim.executionRunId),
      );
      return {
        claims,
        unavailableExecutionRunIds: requestedIds.filter((id) => !availableToActor.has(id)),
      };
    });
  }

  async listClaims(input: Parameters<FailureAnalysisRepository["listClaims"]>[0]) {
    const cursor = decodeRunBatchCursor(input.cursor);
    const where = ["claim.project_id=?", "claim.claimant_id=?"];
    const parameters: Array<string | number> = [input.projectId, input.claimantId];
    if (input.projectVersionId) {
      where.push("json_extract(batch.policy_json, '$.projectVersionId')=?");
      parameters.push(input.projectVersionId);
    }
    if (input.batchId) {
      where.push("claim.batch_id=?");
      parameters.push(input.batchId);
    }
    if (cursor) {
      where.push("(claim.updated_at<? OR (claim.updated_at=? AND claim.id<?))");
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    parameters.push(input.limit + 1);
    const rows = this.handle.client
      .prepare(
        `${claimSelectSql()}
         JOIN run_batches batch ON batch.id=claim.batch_id
         WHERE ${where.join(" AND ")}
         ORDER BY claim.updated_at DESC,claim.id DESC LIMIT ?`,
      )
      .all(...parameters) as FailureAnalysisRow[];
    const hasMore = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toFailureAnalysisClaim),
      ...(hasMore && last?.analysisId && last.analysisUpdatedAt
        ? {
            nextCursor: encodeRunBatchCursor({
              createdAt: last.analysisUpdatedAt,
              id: last.analysisId,
            }),
          }
        : {}),
    };
  }

  async start(input: Parameters<FailureAnalysisRepository["start"]>[0]) {
    this.handle.client
      .prepare(
        `UPDATE failure_analysis_claims
         SET status='analyzing',category=?,analysis_started_at=COALESCE(analysis_started_at,?),updated_at=?
         WHERE id=? AND project_id=? AND claimant_id=?`,
      )
      .run(
        input.category,
        input.startedAt,
        input.startedAt,
        input.analysisId,
        input.projectId,
        input.claimantId,
      );
    const row = this.handle.client
      .prepare(
        `${claimSelectSql()} WHERE claim.id=? AND claim.project_id=? AND claim.claimant_id=?`,
      )
      .get(input.analysisId, input.projectId, input.claimantId) as FailureAnalysisRow | undefined;
    return row ? toFailureAnalysisClaim(row) : null;
  }

  async findOwnedClaims(input: Parameters<FailureAnalysisRepository["findOwnedClaims"]>[0]) {
    if (input.analysisIds.length === 0) return [];
    const placeholders = input.analysisIds.map(() => "?").join(",");
    return (
      this.handle.client
        .prepare(
          `${claimSelectSql()} WHERE claim.project_id=? AND claim.claimant_id=?
           AND claim.id IN (${placeholders})`,
        )
        .all(input.projectId, input.claimantId, ...input.analysisIds) as FailureAnalysisRow[]
    ).map(toFailureAnalysisClaim);
  }

  async getClaim(analysisId: string, projectId: string) {
    const row = this.handle.client
      .prepare(`${claimSelectSql()} WHERE claim.id=? AND claim.project_id=?`)
      .get(analysisId, projectId) as FailureAnalysisRow | undefined;
    return row ? toFailureAnalysisClaim(row) : null;
  }

  async findSuccessfulManualRerunAttempts(
    input: Parameters<FailureAnalysisRepository["findSuccessfulManualRerunAttempts"]>[0],
  ) {
    if (input.analysisIds.length === 0) return new Map<string, string>();
    const placeholders = input.analysisIds.map(() => "?").join(",");
    const rows = this.handle.client
      .prepare(
        `WITH ranked AS (
           SELECT claim.id AS analysisId,attempt.id AS attemptId,
                  ROW_NUMBER() OVER (
                    PARTITION BY claim.id
                    ORDER BY COALESCE(attempt.finished_at,attempt.created_at) DESC,attempt.id DESC
                  ) AS proofRank
           FROM failure_analysis_claims claim
           JOIN run_batches rerun ON rerun.parent_batch_id=claim.batch_id
            AND rerun.source_execution_run_id=claim.execution_run_id
            AND rerun.batch_kind='case_log_rerun'
           JOIN execution_runs run ON run.batch_id=rerun.id
           JOIN run_attempts attempt ON attempt.execution_run_id=run.id
           WHERE claim.project_id=? AND claim.claimant_id=?
             AND claim.id IN (${placeholders})
             AND COALESCE(attempt.outcome,attempt.status)='succeeded'
         )
         SELECT analysisId,attemptId FROM ranked WHERE proofRank=1`,
      )
      .all(input.projectId, input.claimantId, ...input.analysisIds) as Array<{
      analysisId: string;
      attemptId: string;
    }>;
    return new Map(rows.map((row) => [row.analysisId, row.attemptId]));
  }

  async attachScreenshot(input: Parameters<FailureAnalysisRepository["attachScreenshot"]>[0]) {
    return runSqliteWriteTransaction(this.handle, () => {
      const placeholders = input.analysisIds.map(() => "?").join(",");
      this.handle.client
        .prepare(
          `UPDATE failure_analysis_claims
           SET screenshot_object_key=?,screenshot_file_name=?,screenshot_media_type=?,
               screenshot_size_bytes=?,screenshot_sha256=?,updated_at=?
           WHERE project_id=? AND claimant_id=? AND id IN (${placeholders})`,
        )
        .run(
          input.screenshot.objectKey,
          input.screenshot.fileName,
          input.screenshot.mediaType,
          input.screenshot.sizeBytes,
          input.screenshot.sha256,
          input.updatedAt,
          input.projectId,
          input.claimantId,
          ...input.analysisIds,
        );
      return this.selectOwnedClaims(input.analysisIds, input.projectId, input.claimantId);
    });
  }

  async complete(input: Parameters<FailureAnalysisRepository["complete"]>[0]) {
    return runSqliteWriteTransaction(this.handle, () => {
      const update = this.handle.client.prepare(
        `UPDATE failure_analysis_claims
         SET status='completed',category=?,issue_description=?,case_fix_evidence=?,
             ticket_reference=?,remark=?,rerun_proof_attempt_id=?,rerun_proof_url=?,
             analysis_started_at=COALESCE(analysis_started_at,?),completed_at=?,updated_at=?
         WHERE id=? AND project_id=? AND claimant_id=?`,
      );
      for (const analysisId of input.analysisIds) {
        const proof = input.rerunProofs.get(analysisId);
        update.run(
          input.category,
          input.issueDescription ?? null,
          input.caseFixEvidence ?? null,
          input.ticketReference ?? null,
          input.remark ?? null,
          proof?.attemptId ?? null,
          proof?.url ?? null,
          input.completedAt,
          input.completedAt,
          input.completedAt,
          analysisId,
          input.projectId,
          input.claimantId,
        );
      }
      return this.selectOwnedClaims(input.analysisIds, input.projectId, input.claimantId);
    });
  }

  private batchExists(batchId: string, projectId: string, projectVersionId: string): boolean {
    return Boolean(
      this.handle.client
        .prepare(
          `SELECT 1 FROM run_batches
           WHERE id=? AND project_id=?
             AND json_extract(policy_json, '$.projectVersionId')=?
             AND status IN ('succeeded','failed','cancelled')
             AND batch_kind='standard'
             AND EXISTS (SELECT 1 FROM case_suites suite WHERE suite.id=run_batches.suite_id)`,
        )
        .get(batchId, projectId, projectVersionId),
    );
  }

  private selectClaimsByExecutionRunIds(
    projectId: string,
    projectVersionId: string,
    batchId: string,
    executionRunIds: readonly string[],
  ): FailureAnalysisRow[] {
    if (executionRunIds.length === 0) return [];
    const placeholders = executionRunIds.map(() => "?").join(",");
    return this.handle.client
      .prepare(
        `${claimSelectSql()} JOIN run_batches batch ON batch.id=claim.batch_id
         WHERE claim.project_id=? AND claim.batch_id=?
           AND json_extract(batch.policy_json, '$.projectVersionId')=?
           AND claim.execution_run_id IN (${placeholders})`,
      )
      .all(projectId, batchId, projectVersionId, ...executionRunIds) as FailureAnalysisRow[];
  }

  private selectOwnedClaims(analysisIds: readonly string[], projectId: string, claimantId: string) {
    if (analysisIds.length === 0) return [];
    const placeholders = analysisIds.map(() => "?").join(",");
    return (
      this.handle.client
        .prepare(
          `${claimSelectSql()} WHERE claim.project_id=? AND claim.claimant_id=?
           AND claim.id IN (${placeholders})`,
        )
        .all(projectId, claimantId, ...analysisIds) as FailureAnalysisRow[]
    ).map(toFailureAnalysisClaim);
  }
}

function claimSelectSql(): string {
  return `SELECT claim.id AS analysisId,claim.project_id AS projectId,claim.batch_id AS batchId,
                 claim.execution_run_id AS executionRunId,
                 claim.case_definition_id AS caseDefinitionId,claim.attempt_id AS attemptId,
                 claim.case_name AS caseName,claim.class_name AS className,
                 claim.attempt_number AS attemptNumber,claim.failure_summary AS failureSummary,
                 claim.result_code AS resultCode,claim.status AS analysisStatus,claim.category,
                 claim.claimant_id AS claimantId,claim.claimant_username AS claimantUsername,
                 claim.claimant_display_name AS claimantDisplayName,claim.claimed_at AS claimedAt,
                 claim.analysis_started_at AS analysisStartedAt,claim.completed_at AS completedAt,
                 claim.issue_description AS issueDescription,
                 claim.case_fix_evidence AS caseFixEvidence,
                 claim.ticket_reference AS ticketReference,claim.remark,
                 claim.rerun_proof_attempt_id AS rerunProofAttemptId,
                 claim.rerun_proof_url AS rerunProofUrl,
                 claim.screenshot_object_key AS screenshotObjectKey,
                 claim.screenshot_file_name AS screenshotFileName,
                 claim.screenshot_media_type AS screenshotMediaType,
                 claim.screenshot_size_bytes AS screenshotSizeBytes,
                 claim.screenshot_sha256 AS screenshotSha256,
                 claim.updated_at AS analysisUpdatedAt
          FROM failure_analysis_claims claim`;
}

function sqliteCandidateSortExpression(sort: FailureAnalysisSort): string {
  return {
    class_path: "LOWER(SUBSTR(run.class_name,1,512))",
    failure_summary: "LOWER(SUBSTR(COALESCE(attempt.result_summary,attempt.result_code,''),1,512))",
    case_name: "LOWER(SUBSTR(run.display_name,1,512))",
    claim_status: "LOWER(COALESCE(claim.status,'available'))",
  }[sort];
}

function escapeSqliteLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}
