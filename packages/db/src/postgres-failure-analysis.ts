import type { FailureAnalysisRepository } from "@autoforge/application";
import type {
  FailureAnalysisBatchPage,
  FailureAnalysisCandidatePage,
  FailureAnalysisSort,
} from "@autoforge/contracts";

import type { PostgresDatabaseHandle } from "./postgres-database";
import {
  decodeFailureAnalysisCandidateCursor,
  decodeFailureAnalysisClaimCursor,
  encodeFailureAnalysisCandidateCursor,
  encodeFailureAnalysisClaimCursor,
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
  failedRuns: string;
  claimedRuns: string;
  completedRuns: string;
  createdAt: string;
};

type FailureAnalysisHistoryRow = FailureAnalysisRow & {
  batchSequenceNumber: string | number;
  batchName: string;
};

export class PostgresFailureAnalysisRepository implements FailureAnalysisRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async listBatches(input: {
    projectId: string;
    projectVersionId?: string;
    cursor?: string;
    limit: number;
  }): Promise<FailureAnalysisBatchPage> {
    await this.handle.ready;
    const cursor = decodeRunBatchCursor(input.cursor);
    const parameters: unknown[] = [input.projectId];
    const where = [
      "batch.project_id=$1",
      "batch.status IN ('succeeded','failed','cancelled')",
      "batch.batch_kind='standard'",
      "EXISTS (SELECT 1 FROM case_suites suite WHERE suite.id=batch.suite_id)",
      `EXISTS (SELECT 1 FROM execution_runs run
               JOIN run_attempts attempt ON attempt.execution_run_id=run.id
                AND attempt.execution_round=batch.current_round
                AND attempt.attempt_number=(
                  SELECT MAX(latest.attempt_number) FROM run_attempts latest
                  WHERE latest.execution_run_id=run.id
                    AND latest.execution_round=batch.current_round)
               WHERE run.batch_id=batch.id AND run.terminal_outcome='failed'
                 AND COALESCE(attempt.outcome,attempt.status)='failed')`,
    ];
    if (input.projectVersionId) {
      parameters.push(input.projectVersionId);
      where.push(`batch.policy_json::jsonb ->> 'projectVersionId'=$${parameters.length}`);
    }
    if (cursor) {
      parameters.push(cursor.createdAt, cursor.id);
      where.push(
        `(batch.created_at<$${parameters.length - 1} OR (batch.created_at=$${parameters.length - 1} AND batch.id<$${parameters.length}))`,
      );
    }
    parameters.push(input.limit + 1);
    const result = await this.handle.pool.query<BatchRow>(
      `SELECT batch.id,batch.sequence_number AS "sequenceNumber",batch.suite_name AS "suiteName",
              batch.current_round AS "currentRound",
              (SELECT COUNT(*) FROM execution_runs run
               JOIN run_attempts attempt ON attempt.execution_run_id=run.id
                AND attempt.execution_round=batch.current_round
                AND attempt.attempt_number=(
                  SELECT MAX(latest.attempt_number) FROM run_attempts latest
                  WHERE latest.execution_run_id=run.id
                    AND latest.execution_round=batch.current_round)
               WHERE run.batch_id=batch.id AND run.terminal_outcome='failed'
                 AND COALESCE(attempt.outcome,attempt.status)='failed') AS "failedRuns",
              (SELECT COUNT(*) FROM failure_analysis_claims claim
               WHERE claim.batch_id=batch.id) AS "claimedRuns",
              (SELECT COUNT(*) FROM failure_analysis_claims claim
               WHERE claim.batch_id=batch.id AND claim.status='completed') AS "completedRuns",
              batch.created_at AS "createdAt"
       FROM run_batches batch WHERE ${where.join(" AND ")}
       ORDER BY batch.created_at DESC,batch.id DESC LIMIT $${parameters.length}`,
      parameters,
    );
    const hasMore = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit);
    const items = rows.map(toFailureAnalysisBatch);
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last
        ? { nextCursor: encodeRunBatchCursor({ createdAt: last.createdAt, id: last.id }) }
        : {}),
    };
  }

  async getBatch(input: Parameters<FailureAnalysisRepository["getBatch"]>[0]) {
    await this.handle.ready;
    const result = await this.handle.pool.query<BatchRow>(
      `SELECT batch.id,batch.sequence_number AS "sequenceNumber",batch.suite_name AS "suiteName",
              batch.current_round AS "currentRound",
              (SELECT COUNT(*) FROM execution_runs run
               JOIN run_attempts attempt ON attempt.execution_run_id=run.id
                AND attempt.execution_round=batch.current_round
                AND attempt.attempt_number=(
                  SELECT MAX(latest.attempt_number) FROM run_attempts latest
                  WHERE latest.execution_run_id=run.id
                    AND latest.execution_round=batch.current_round)
               WHERE run.batch_id=batch.id AND run.terminal_outcome='failed'
                 AND COALESCE(attempt.outcome,attempt.status)='failed') AS "failedRuns",
              (SELECT COUNT(*) FROM failure_analysis_claims claim
               WHERE claim.batch_id=batch.id) AS "claimedRuns",
              (SELECT COUNT(*) FROM failure_analysis_claims claim
               WHERE claim.batch_id=batch.id AND claim.status='completed') AS "completedRuns",
              batch.created_at AS "createdAt"
       FROM run_batches batch
       WHERE batch.id=$1 AND batch.project_id=$2
         AND batch.policy_json::jsonb ->> 'projectVersionId'=$3
         AND batch.status IN ('succeeded','failed','cancelled')
         AND batch.batch_kind='standard'
         AND EXISTS (SELECT 1 FROM case_suites suite WHERE suite.id=batch.suite_id)`,
      [input.batchId, input.projectId, input.projectVersionId],
    );
    return result.rows[0] ? toFailureAnalysisBatch(result.rows[0]) : null;
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
    await this.handle.ready;
    const sortExpression = postgresCandidateSortExpression(input.sort);
    const claimRankExpression = "CASE WHEN claim.id IS NULL THEN 0 ELSE 1 END";
    const cursor = decodeFailureAnalysisCandidateCursor(input.cursor, input.sort, input.direction);
    const parameters: unknown[] = [input.batchId, input.projectId, input.projectVersionId];
    const where = [
      "batch.id=$1",
      "batch.project_id=$2",
      "batch.policy_json::jsonb ->> 'projectVersionId'=$3",
      "batch.status IN ('succeeded','failed','cancelled')",
      "batch.batch_kind='standard'",
      "EXISTS (SELECT 1 FROM case_suites suite WHERE suite.id=batch.suite_id)",
      "run.terminal_outcome='failed'",
      "COALESCE(attempt.outcome,attempt.status)='failed'",
    ];
    if (input.query?.trim()) {
      parameters.push(`%${escapePostgresLike(input.query.trim().toLowerCase())}%`);
      where.push(
        `LOWER(run.class_name || ' ' || run.display_name || ' ' ||
          LEFT(COALESCE(attempt.result_summary,attempt.result_code,''),
               ${FAILURE_ANALYSIS_SUMMARY_MAXIMUM_CHARACTERS})) LIKE $${parameters.length} ESCAPE '\\'`,
      );
    }
    if (cursor) {
      const comparison = input.direction === "desc" ? "<" : ">";
      parameters.push(cursor.claimRank, cursor.value, cursor.executionRunId);
      where.push(
        `(${claimRankExpression}>$${parameters.length - 2} OR
          (${claimRankExpression}=$${parameters.length - 2} AND
           (${sortExpression}${comparison}$${parameters.length - 1} OR
            (${sortExpression}=$${parameters.length - 1} AND
             run.id${comparison}$${parameters.length}))))`,
      );
    }
    parameters.push(input.limit + 1);
    const direction = input.direction === "desc" ? "DESC" : "ASC";
    const result = await this.handle.pool.query<FailureAnalysisRow>(
      `SELECT claim.id AS "analysisId",batch.project_id AS "projectId",batch.id AS "batchId",
              run.id AS "executionRunId",run.case_definition_id AS "caseDefinitionId",
              attempt.id AS "attemptId",run.display_name AS "caseName",run.class_name AS "className",
              attempt.attempt_number AS "attemptNumber",
              COALESCE(NULLIF(BTRIM(LEFT(attempt.result_summary,
                ${FAILURE_ANALYSIS_SUMMARY_MAXIMUM_CHARACTERS})),''),attempt.result_code,
                '未提供失败堆栈。') AS "failureSummary",
              attempt.result_code AS "resultCode",claim.status AS "analysisStatus",
              claim.category,claim.claimant_id AS "claimantId",
              claim.claimant_username AS "claimantUsername",
              claim.claimant_display_name AS "claimantDisplayName",
              claim.claimed_at AS "claimedAt",claim.analysis_started_at AS "analysisStartedAt",
              claim.completed_at AS "completedAt",claim.issue_description AS "issueDescription",
              claim.case_fix_evidence AS "caseFixEvidence",
              claim.ticket_reference AS "ticketReference",claim.remark,
              claim.rerun_proof_attempt_id AS "rerunProofAttemptId",
              claim.rerun_proof_url AS "rerunProofUrl",
              claim.screenshot_object_key AS "screenshotObjectKey",
              claim.screenshot_file_name AS "screenshotFileName",
              claim.screenshot_media_type AS "screenshotMediaType",
              claim.screenshot_size_bytes AS "screenshotSizeBytes",
              claim.screenshot_sha256 AS "screenshotSha256",
              claim.updated_at AS "analysisUpdatedAt",
              ${claimRankExpression} AS "claimRank",${sortExpression} AS "sortValue"
       FROM run_batches batch JOIN execution_runs run ON run.batch_id=batch.id
       JOIN run_attempts attempt ON attempt.execution_run_id=run.id
        AND attempt.execution_round=batch.current_round
        AND attempt.attempt_number=(
          SELECT MAX(latest.attempt_number) FROM run_attempts latest
          WHERE latest.execution_run_id=run.id
            AND latest.execution_round=batch.current_round)
       LEFT JOIN failure_analysis_claims claim ON claim.execution_run_id=run.id
       WHERE ${where.join(" AND ")}
       ORDER BY ${claimRankExpression} ASC,${sortExpression} ${direction},run.id ${direction}
       LIMIT $${parameters.length}`,
      parameters,
    );
    // 主查询已有完整的项目、版本、类型和终态守卫。有候选时无需再做一次网络往返；
    // 空结果才补查批次，用于保持 null（不可见）与空页（无匹配）的 API 语义。
    if (
      result.rows.length === 0 &&
      !(await this.batchExists(input.batchId, input.projectId, input.projectVersionId))
    ) {
      return null;
    }
    const hasMore = result.rows.length > input.limit;
    const pageRows = result.rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toFailureAnalysisCandidate),
      ...(hasMore && last
        ? {
            nextCursor: encodeFailureAnalysisCandidateCursor({
              sort: input.sort,
              direction: input.direction,
              claimRank: Number(last.claimRank ?? (last.analysisId ? 1 : 0)),
              value: last.sortValue ?? "",
              executionRunId: last.executionRunId,
            }),
          }
        : {}),
    };
  }

  async claim(input: Parameters<FailureAnalysisRepository["claim"]>[0]) {
    await this.handle.ready;
    const client = await this.handle.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `WITH requested(id,execution_run_id) AS (
           SELECT * FROM UNNEST($4::text[],$5::text[])
         )
         INSERT INTO failure_analysis_claims
          (id,project_id,batch_id,execution_run_id,case_definition_id,attempt_id,case_name,
           class_name,attempt_number,failure_summary,result_code,status,category,claimant_id,
           claimant_username,claimant_display_name,claimed_at,analysis_started_at,updated_at)
         SELECT requested.id,$1,batch.id,run.id,run.case_definition_id,attempt.id,
                run.display_name,run.class_name,attempt.attempt_number,
                COALESCE(NULLIF(BTRIM(LEFT(attempt.result_summary,
                  ${FAILURE_ANALYSIS_SUMMARY_MAXIMUM_CHARACTERS})),''),attempt.result_code,
                  '未提供失败堆栈。'),
                attempt.result_code,'claimed',NULL,$6,$7,$8,$9,NULL,$9
         FROM requested JOIN execution_runs run ON run.id=requested.execution_run_id
         JOIN run_batches batch ON batch.id=run.batch_id
         JOIN run_attempts attempt ON attempt.execution_run_id=run.id
          AND attempt.execution_round=batch.current_round
          AND attempt.attempt_number=(
            SELECT MAX(latest.attempt_number) FROM run_attempts latest
            WHERE latest.execution_run_id=run.id
              AND latest.execution_round=batch.current_round)
         WHERE batch.id=$2 AND batch.project_id=$1 AND run.terminal_outcome='failed'
           AND batch.policy_json::jsonb ->> 'projectVersionId'=$3
           AND batch.status IN ('succeeded','failed','cancelled')
           AND batch.batch_kind='standard'
           AND EXISTS (SELECT 1 FROM case_suites suite WHERE suite.id=batch.suite_id)
           AND COALESCE(attempt.outcome,attempt.status)='failed'
         ON CONFLICT (execution_run_id) DO NOTHING`,
        [
          input.projectId,
          input.batchId,
          input.projectVersionId,
          input.claims.map((claim) => claim.id),
          input.claims.map((claim) => claim.executionRunId),
          input.claimantId,
          input.claimantUsername,
          input.claimantDisplayName,
          input.claimedAt,
        ],
      );
      const result = await client.query<FailureAnalysisRow>(
        `${claimSelectSql()} JOIN run_batches batch ON batch.id=claim.batch_id
         WHERE claim.project_id=$1 AND claim.batch_id=$2
           AND batch.policy_json::jsonb ->> 'projectVersionId'=$3
           AND claim.execution_run_id=ANY($4::text[])`,
        [input.projectId, input.batchId, input.projectVersionId, [...input.executionRunIds]],
      );
      await client.query("COMMIT");
      const claims = result.rows.map(toFailureAnalysisClaim);
      const availableToActor = new Set(
        claims
          .filter((claim) => claim.claimantId === input.claimantId)
          .map((claim) => claim.executionRunId),
      );
      return {
        claims,
        unavailableExecutionRunIds: input.executionRunIds.filter((id) => !availableToActor.has(id)),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async release(input: Parameters<FailureAnalysisRepository["release"]>[0]) {
    await this.handle.ready;
    const client = await this.handle.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<FailureAnalysisRow>(
        `${claimSelectSql()} WHERE claim.id=$1 AND claim.project_id=$2 AND claim.claimant_id=$3
         AND claim.status IN ('claimed','analyzing') FOR UPDATE`,
        [input.analysisId, input.projectId, input.claimantId],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      const claim = toFailureAnalysisClaim(row);
      const removed = await client.query(
        `DELETE FROM failure_analysis_claims
         WHERE id=$1 AND project_id=$2 AND claimant_id=$3
           AND status IN ('claimed','analyzing')`,
        [input.analysisId, input.projectId, input.claimantId],
      );
      if (removed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `INSERT INTO failure_analysis_claim_releases
          (id,analysis_id,project_id,batch_id,execution_run_id,case_definition_id,
           claimant_id,claimant_username,claimant_display_name,reason,claimed_at,released_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          input.id,
          claim.id,
          claim.projectId,
          claim.batchId,
          claim.executionRunId,
          claim.caseDefinitionId,
          claim.claimantId,
          claim.claimantUsername,
          claim.claimantDisplayName,
          input.reason,
          claim.claimedAt,
          input.releasedAt,
        ],
      );
      await client.query("COMMIT");
      return {
        id: input.id,
        analysisId: claim.id,
        projectId: claim.projectId,
        batchId: claim.batchId,
        executionRunId: claim.executionRunId,
        caseDefinitionId: claim.caseDefinitionId,
        claimantId: claim.claimantId,
        claimantUsername: claim.claimantUsername,
        claimantDisplayName: claim.claimantDisplayName,
        reason: input.reason,
        claimedAt: claim.claimedAt,
        releasedAt: input.releasedAt,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listClaims(input: Parameters<FailureAnalysisRepository["listClaims"]>[0]) {
    await this.handle.ready;
    const completionOrder = input.completionOrder ?? "pending_first";
    const includeCompleted = input.includeCompleted ?? true;
    const completionExpression = postgresCompletionRankExpression(completionOrder);
    const sortExpression = postgresClaimSortExpression(input.sort);
    const parameters: unknown[] = [input.projectId, input.claimantId];
    const where = ["claim.project_id=$1", "claim.claimant_id=$2"];
    if (input.projectVersionId) {
      parameters.push(input.projectVersionId);
      where.push(`batch.policy_json::jsonb ->> 'projectVersionId'=$${parameters.length}`);
    }
    if (input.batchId) {
      parameters.push(input.batchId);
      where.push(`claim.batch_id=$${parameters.length}`);
    }
    const query = input.query?.trim().slice(0, 240);
    if (query) {
      parameters.push(`%${escapePostgresLike(query.toLowerCase())}%`);
      where.push(
        `LOWER(claim.class_name || ' ' || claim.case_name || ' ' || claim.failure_summary)
         LIKE $${parameters.length} ESCAPE '\\'`,
      );
    }
    if (!includeCompleted) where.push("claim.status<>'completed'");
    const cursor = decodeFailureAnalysisClaimCursor(
      input.cursor,
      input.sort,
      input.direction,
      completionOrder,
      includeCompleted,
    );
    if (cursor) {
      parameters.push(cursor.completionRank, cursor.value, cursor.analysisId);
      const comparison = input.direction === "desc" ? "<" : ">";
      where.push(
        `(${completionExpression}>$${parameters.length - 2} OR
          (${completionExpression}=$${parameters.length - 2} AND
           (${sortExpression}${comparison}$${parameters.length - 1} OR
            (${sortExpression}=$${parameters.length - 1} AND claim.id${comparison}$${parameters.length}))))`,
      );
    }
    parameters.push(input.limit + 1);
    const direction = input.direction === "desc" ? "DESC" : "ASC";
    const result = await this.handle.pool.query<FailureAnalysisRow>(
      `${claimSelectSql(
        `${sortExpression} AS "sortValue",${completionExpression} AS "completionRank"`,
      )} JOIN run_batches batch ON batch.id=claim.batch_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${completionExpression} ASC,${sortExpression} ${direction},claim.id ${direction}
       LIMIT $${parameters.length}`,
      parameters,
    );
    const hasMore = result.rows.length > input.limit;
    const pageRows = result.rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toFailureAnalysisClaim),
      ...(hasMore && last?.analysisId
        ? {
            nextCursor: encodeFailureAnalysisClaimCursor({
              sort: input.sort,
              direction: input.direction,
              completionOrder,
              completionRank: Number(last.completionRank ?? 0),
              includeCompleted,
              value: last.sortValue ?? "",
              analysisId: last.analysisId,
            }),
          }
        : {}),
    };
  }

  async countClaims(input: Parameters<FailureAnalysisRepository["countClaims"]>[0]) {
    await this.handle.ready;
    const parameters: string[] = [input.projectId, input.claimantId];
    const where = ["claim.project_id=$1", "claim.claimant_id=$2"];
    if (input.projectVersionId) {
      parameters.push(input.projectVersionId);
      where.push(`batch.policy_json::jsonb ->> 'projectVersionId'=$${parameters.length}`);
    }
    if (input.batchId) {
      parameters.push(input.batchId);
      where.push(`claim.batch_id=$${parameters.length}`);
    }
    const result = await this.handle.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM failure_analysis_claims claim
       JOIN run_batches batch ON batch.id=claim.batch_id
       WHERE ${where.join(" AND ")}`,
      parameters,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async findClaimsByExecutionRunIds(
    input: Parameters<FailureAnalysisRepository["findClaimsByExecutionRunIds"]>[0],
  ) {
    if (input.executionRunIds.length === 0) return [];
    await this.handle.ready;
    const result = await this.handle.pool.query<FailureAnalysisRow>(
      `${claimSelectSql()} WHERE claim.project_id=$1 AND claim.batch_id=$2
       AND claim.execution_run_id=ANY($3::text[])`,
      [input.projectId, input.batchId, [...input.executionRunIds]],
    );
    return result.rows.map(toFailureAnalysisClaim);
  }

  async listCaseHistory(input: Parameters<FailureAnalysisRepository["listCaseHistory"]>[0]) {
    await this.handle.ready;
    const parameters: unknown[] = [input.projectId, input.caseDefinitionId];
    const where = [
      "claim.project_id=$1",
      "claim.case_definition_id=$2",
      "claim.status='completed'",
      "claim.completed_at IS NOT NULL",
    ];
    const cursor = decodeRunBatchCursor(input.cursor);
    if (cursor) {
      parameters.push(cursor.createdAt, cursor.id);
      where.push(
        `(claim.completed_at<$${parameters.length - 1} OR
          (claim.completed_at=$${parameters.length - 1} AND claim.id<$${parameters.length}))`,
      );
    }
    parameters.push(input.limit + 1);
    const result = await this.handle.pool.query<FailureAnalysisHistoryRow>(
      `SELECT history.*,batch.sequence_number AS "batchSequenceNumber",
              batch.suite_name AS "batchName"
       FROM (${claimSelectSql()} WHERE ${where.join(" AND ")}) history
       JOIN run_batches batch ON batch.id=history."batchId"
       ORDER BY history."completedAt" DESC,history."analysisId" DESC
       LIMIT $${parameters.length}`,
      parameters,
    );
    return historyPage(result.rows, input.limit);
  }

  async listRecentCaseHistories(
    input: Parameters<FailureAnalysisRepository["listRecentCaseHistories"]>[0],
  ) {
    if (input.caseDefinitionIds.length === 0) return [];
    await this.handle.ready;
    const result = await this.handle.pool.query<FailureAnalysisHistoryRow>(
      `SELECT ranked.*,batch.sequence_number AS "batchSequenceNumber",
              batch.suite_name AS "batchName"
       FROM (
         SELECT history.*,
                ROW_NUMBER() OVER (
                  PARTITION BY history."caseDefinitionId"
                  ORDER BY history."completedAt" DESC,history."analysisId" DESC
                ) AS "historyRank"
         FROM (${claimSelectSql()}
               WHERE claim.project_id=$1 AND claim.status='completed'
                 AND claim.completed_at IS NOT NULL
                 AND claim.case_definition_id=ANY($2::text[])) history
       ) ranked
       JOIN run_batches batch ON batch.id=ranked."batchId"
       WHERE ranked."historyRank"<=$3
       ORDER BY ranked."caseDefinitionId",ranked."completedAt" DESC,
                ranked."analysisId" DESC`,
      [input.projectId, [...input.caseDefinitionIds], input.limitPerCase],
    );
    return result.rows.map(toHistoryItem);
  }

  async listCompletedConclusions(
    input: Parameters<FailureAnalysisRepository["listCompletedConclusions"]>[0],
  ) {
    await this.handle.ready;
    const parameters: unknown[] = [input.projectId];
    const where = [
      "claim.project_id=$1",
      "claim.status='completed'",
      "claim.completed_at IS NOT NULL",
    ];
    const query = input.query?.trim().slice(0, 200);
    if (query) {
      parameters.push(`%${escapePostgresLike(query)}%`);
      const placeholder = `$${parameters.length}`;
      where.push(`(claim.case_name ILIKE ${placeholder} ESCAPE '\\'
        OR claim.class_name ILIKE ${placeholder} ESCAPE '\\'
        OR claim.failure_summary ILIKE ${placeholder} ESCAPE '\\'
        OR COALESCE(claim.issue_description,'') ILIKE ${placeholder} ESCAPE '\\'
        OR COALESCE(claim.ticket_reference,'') ILIKE ${placeholder} ESCAPE '\\'
        OR COALESCE(claim.remark,'') ILIKE ${placeholder} ESCAPE '\\')`);
    }
    const cursor = decodeRunBatchCursor(input.cursor);
    if (cursor) {
      parameters.push(cursor.createdAt, cursor.id);
      where.push(
        `(claim.completed_at<$${parameters.length - 1} OR
          (claim.completed_at=$${parameters.length - 1} AND claim.id<$${parameters.length}))`,
      );
    }
    parameters.push(input.limit + 1);
    const result = await this.handle.pool.query<FailureAnalysisHistoryRow>(
      `SELECT history.*,batch.sequence_number AS "batchSequenceNumber",
              batch.suite_name AS "batchName"
       FROM (${claimSelectSql()} WHERE ${where.join(" AND ")}) history
       JOIN run_batches batch ON batch.id=history."batchId"
       ORDER BY history."completedAt" DESC,history."analysisId" DESC
       LIMIT $${parameters.length}`,
      parameters,
    );
    return historyPage(result.rows, input.limit);
  }

  async start(input: Parameters<FailureAnalysisRepository["start"]>[0]) {
    await this.handle.ready;
    const updated = await this.handle.pool.query(
      `UPDATE failure_analysis_claims
       SET status='analyzing',category=$1,analysis_started_at=COALESCE(analysis_started_at,$2),updated_at=$2
       WHERE id=$3 AND project_id=$4 AND claimant_id=$5 RETURNING id`,
      [input.category, input.startedAt, input.analysisId, input.projectId, input.claimantId],
    );
    if (updated.rowCount === 0) return null;
    const result = await this.handle.pool.query<FailureAnalysisRow>(
      `${claimSelectSql()} WHERE claim.id=$1 AND claim.project_id=$2 AND claim.claimant_id=$3`,
      [input.analysisId, input.projectId, input.claimantId],
    );
    return result.rows[0] ? toFailureAnalysisClaim(result.rows[0]) : null;
  }

  async findOwnedClaims(input: Parameters<FailureAnalysisRepository["findOwnedClaims"]>[0]) {
    await this.handle.ready;
    const result = await this.handle.pool.query<FailureAnalysisRow>(
      `${claimSelectSql()} WHERE claim.project_id=$1 AND claim.claimant_id=$2
       AND claim.id=ANY($3::text[])`,
      [input.projectId, input.claimantId, [...input.analysisIds]],
    );
    return result.rows.map(toFailureAnalysisClaim);
  }

  async getClaim(analysisId: string, projectId: string) {
    await this.handle.ready;
    const result = await this.handle.pool.query<FailureAnalysisRow>(
      `${claimSelectSql()} WHERE claim.id=$1 AND claim.project_id=$2`,
      [analysisId, projectId],
    );
    return result.rows[0] ? toFailureAnalysisClaim(result.rows[0]) : null;
  }

  async findSuccessfulManualRerunAttempts(
    input: Parameters<FailureAnalysisRepository["findSuccessfulManualRerunAttempts"]>[0],
  ) {
    await this.handle.ready;
    const result = await this.handle.pool.query<{ analysisId: string; attemptId: string }>(
      `SELECT DISTINCT ON (claim.id)
              claim.id AS "analysisId",attempt.id AS "attemptId"
       FROM failure_analysis_claims claim
       JOIN run_batches rerun ON rerun.parent_batch_id=claim.batch_id
        AND rerun.source_execution_run_id=claim.execution_run_id
        AND rerun.batch_kind='case_log_rerun'
       JOIN execution_runs run ON run.batch_id=rerun.id
       JOIN run_attempts attempt ON attempt.execution_run_id=run.id
       WHERE claim.project_id=$1 AND claim.claimant_id=$2
         AND claim.id=ANY($3::text[])
         AND COALESCE(attempt.outcome,attempt.status)='succeeded'
       ORDER BY claim.id,COALESCE(attempt.finished_at,attempt.created_at) DESC,attempt.id DESC`,
      [input.projectId, input.claimantId, [...input.analysisIds]],
    );
    return new Map(result.rows.map((row) => [row.analysisId, row.attemptId]));
  }

  async attachScreenshot(input: Parameters<FailureAnalysisRepository["attachScreenshot"]>[0]) {
    await this.handle.ready;
    await this.handle.pool.query(
      `UPDATE failure_analysis_claims
       SET screenshot_object_key=$1,screenshot_file_name=$2,screenshot_media_type=$3,
           screenshot_size_bytes=$4,screenshot_sha256=$5,updated_at=$6
       WHERE project_id=$7 AND claimant_id=$8 AND id=ANY($9::text[])`,
      [
        input.screenshot.objectKey,
        input.screenshot.fileName,
        input.screenshot.mediaType,
        input.screenshot.sizeBytes,
        input.screenshot.sha256,
        input.updatedAt,
        input.projectId,
        input.claimantId,
        [...input.analysisIds],
      ],
    );
    return this.findOwnedClaims(input);
  }

  async complete(input: Parameters<FailureAnalysisRepository["complete"]>[0]) {
    await this.handle.ready;
    const client = await this.handle.pool.connect();
    try {
      await client.query("BEGIN");
      const proofAttemptIds = input.analysisIds.map(
        (analysisId) => input.rerunProofs.get(analysisId)?.attemptId ?? null,
      );
      const proofUrls = input.analysisIds.map(
        (analysisId) => input.rerunProofs.get(analysisId)?.url ?? null,
      );
      // 一次 UNNEST 条件更新替代每个分析任务一次网络往返。一次批量最多 100 项，
      // 数组大小始终有界，同时每项仍可保存不同的重跑 attempt 与永久链接。
      await client.query(
        `WITH selected(id,proof_attempt_id,proof_url) AS (
           SELECT * FROM UNNEST($9::text[],$10::text[],$11::text[])
         )
         UPDATE failure_analysis_claims claim
         SET status='completed',category=$1,issue_description=$2,case_fix_evidence=$3,
             ticket_reference=$4,remark=$5,
             rerun_proof_attempt_id=selected.proof_attempt_id,
             rerun_proof_url=selected.proof_url,
             analysis_started_at=COALESCE(claim.analysis_started_at,$6),
             completed_at=$6,updated_at=$6
         FROM selected
         WHERE claim.id=selected.id AND claim.project_id=$7 AND claim.claimant_id=$8`,
        [
          input.category,
          input.issueDescription ?? null,
          input.caseFixEvidence ?? null,
          input.ticketReference ?? null,
          input.remark ?? null,
          input.completedAt,
          input.projectId,
          input.claimantId,
          [...input.analysisIds],
          proofAttemptIds,
          proofUrls,
        ],
      );
      const result = await client.query<FailureAnalysisRow>(
        `${claimSelectSql()} WHERE claim.project_id=$1 AND claim.claimant_id=$2
         AND claim.id=ANY($3::text[])`,
        [input.projectId, input.claimantId, [...input.analysisIds]],
      );
      await client.query("COMMIT");
      return result.rows.map(toFailureAnalysisClaim);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async batchExists(
    batchId: string,
    projectId: string,
    projectVersionId: string,
  ): Promise<boolean> {
    const result = await this.handle.pool.query(
      `SELECT 1 FROM run_batches
       WHERE id=$1 AND project_id=$2 AND policy_json::jsonb ->> 'projectVersionId'=$3
         AND status IN ('succeeded','failed','cancelled')
         AND batch_kind='standard'
         AND EXISTS (SELECT 1 FROM case_suites suite WHERE suite.id=run_batches.suite_id)`,
      [batchId, projectId, projectVersionId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

function claimSelectSql(extraSelection?: string): string {
  return `SELECT claim.id AS "analysisId",claim.project_id AS "projectId",
                 claim.batch_id AS "batchId",claim.execution_run_id AS "executionRunId",
                 claim.case_definition_id AS "caseDefinitionId",claim.attempt_id AS "attemptId",
                 claim.case_name AS "caseName",claim.class_name AS "className",
                 claim.attempt_number AS "attemptNumber",claim.failure_summary AS "failureSummary",
                 claim.result_code AS "resultCode",claim.status AS "analysisStatus",claim.category,
                 claim.claimant_id AS "claimantId",claim.claimant_username AS "claimantUsername",
                 claim.claimant_display_name AS "claimantDisplayName",claim.claimed_at AS "claimedAt",
                 claim.analysis_started_at AS "analysisStartedAt",
                 claim.completed_at AS "completedAt",
                 claim.issue_description AS "issueDescription",
                 claim.case_fix_evidence AS "caseFixEvidence",
                 claim.ticket_reference AS "ticketReference",claim.remark,
                 claim.rerun_proof_attempt_id AS "rerunProofAttemptId",
                 claim.rerun_proof_url AS "rerunProofUrl",
                 claim.screenshot_object_key AS "screenshotObjectKey",
                 claim.screenshot_file_name AS "screenshotFileName",
                 claim.screenshot_media_type AS "screenshotMediaType",
                 claim.screenshot_size_bytes AS "screenshotSizeBytes",
                 claim.screenshot_sha256 AS "screenshotSha256",
                 claim.updated_at AS "analysisUpdatedAt"${extraSelection ? `,${extraSelection}` : ""}
          FROM failure_analysis_claims claim`;
}

function toHistoryItem(row: FailureAnalysisHistoryRow) {
  return {
    claim: toFailureAnalysisClaim(row),
    batchSequenceNumber: Number(row.batchSequenceNumber),
    batchName: row.batchName,
  };
}

function postgresCandidateSortExpression(sort: FailureAnalysisSort): string {
  return {
    class_path: "LOWER(LEFT(run.class_name,512))",
    failure_summary: "LOWER(LEFT(COALESCE(attempt.result_summary,attempt.result_code,''),512))",
    case_name: "LOWER(LEFT(run.display_name,512))",
    claim_status: "LOWER(COALESCE(claim.status,'available'))",
  }[sort];
}

function postgresClaimSortExpression(sort: FailureAnalysisSort): string {
  return {
    class_path: "LOWER(LEFT(claim.class_name,512))",
    failure_summary: "LOWER(LEFT(claim.failure_summary,512))",
    case_name: "LOWER(LEFT(claim.case_name,512))",
    claim_status:
      "CASE claim.status WHEN 'claimed' THEN '1' WHEN 'analyzing' THEN '2' ELSE '3' END",
  }[sort];
}

function postgresCompletionRankExpression(
  completionOrder: "pending_first" | "completed_first",
): string {
  return completionOrder === "pending_first"
    ? "CASE WHEN claim.status='completed' THEN 1 ELSE 0 END"
    : "CASE WHEN claim.status='completed' THEN 0 ELSE 1 END";
}

function historyPage(rows: FailureAnalysisHistoryRow[], limit: number) {
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(toHistoryItem),
    ...(hasMore && last?.completedAt
      ? {
          nextCursor: encodeRunBatchCursor({
            createdAt: last.completedAt,
            id: last.analysisId!,
          }),
        }
      : {}),
  };
}

function escapePostgresLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function toFailureAnalysisBatch(row: BatchRow) {
  return {
    ...row,
    failedRuns: Number(row.failedRuns),
    claimedRuns: Number(row.claimedRuns),
    completedRuns: Number(row.completedRuns),
  };
}
