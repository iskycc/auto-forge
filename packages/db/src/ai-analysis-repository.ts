import type {
  AiAnalysisRepository,
  AiConfigurationRecord,
  AiPlanningJob,
  AiCandidate,
  AiWork,
  AiGroupWork,
  AiIssueRefinement,
} from "@autoforge/application";
import {
  AI_BATCH_CLASSIFICATION_STRATEGY,
  AI_INTERMEDIATE_CONCLUSION_SUFFIX,
  aiAnalysisRuntimeSchema,
  aiModelRequestStageSchema,
  aiModelConfigurationSchema,
  type AiAnalysisJob,
  type AiAnalysisItem,
  type AiConclusionDraft,
} from "@autoforge/contracts";
import { SqlAiIssueClassification } from "./ai-issue-classification";

export type AiSqlStatement = { text: string; values: Array<string | number | null> };
export type AiSql = (statement: AiSqlStatement) => Promise<Record<string, unknown>[]>;
export type AiSqlBatch = (statements: AiSqlStatement[]) => Promise<Record<string, unknown>[][]>;
const statement = (text: string, ...values: AiSqlStatement["values"]): AiSqlStatement => ({
  text,
  values,
});
const ACTIVE_JOB = "status IN ('queued','preparing','analyzing','summarizing')";
const RUNTIME_JOB_LIMIT = 20;
const REUSABLE_STACK_GROUP =
  "member_count>=10 AND signature LIKE 'exact-stack-bundle-%' AND conclusion IS NOT NULL AND status='completed'";
const CLAIMABLE_ITEM = `j.status='analyzing' AND i.status IN ('queued','ready','retry_wait','collecting','analyzing')
  AND (i.evidence_key IS NULL OR j.strategy NOT IN ('stack_groups_v2','${AI_BATCH_CLASSIFICATION_STRATEGY}')
       OR (j.strategy='${AI_BATCH_CLASSIFICATION_STRATEGY}' AND j.issue_phase='individual'))`;
const OPEN_INDEPENDENT_ANALYSIS = `j.status='summarizing' AND j.strategy='${AI_BATCH_CLASSIFICATION_STRATEGY}'`;
const OWNED_ITEM_JOB = `EXISTS(SELECT 1 FROM ai_analysis_jobs j
  WHERE j.id=job_id AND (j.status='analyzing' OR (${OPEN_INDEPENDENT_ANALYSIS} AND evidence_key IS NOT NULL)))`;

/** Shared SQL semantics; each dialect owns binding, transactions and short lock budgets. */
export class SqlAiAnalysisRepository implements AiAnalysisRepository {
  readonly issues: SqlAiIssueClassification;
  constructor(
    private readonly query: AiSql,
    private readonly write: AiSqlBatch,
    private readonly wakeup: (job: AiAnalysisJob) => AiSqlStatement,
  ) {
    this.issues = new SqlAiIssueClassification(query, write);
  }

  async configuration(): Promise<AiConfigurationRecord> {
    const row = (
      await this.query(statement("SELECT * FROM ai_model_configuration WHERE id='default'"))
    )[0];
    return row
      ? {
          revision: Number(row.revision),
          configuration: aiModelConfigurationSchema.parse(
            JSON.parse(String(row.configuration_json)),
          ),
          encryptedKey: row.encrypted_key === null ? null : String(row.encrypted_key),
        }
      : { revision: 0, configuration: null, encryptedKey: null };
  }
  async runtime(input: { now: string; projectIds?: readonly string[] }) {
    const jobs =
      input.projectIds?.length === 0
        ? Promise.resolve([])
        : this.query(
            statement(
              `SELECT j.id,j.batch_id,j.attempt_id,j.status,j.strategy,j.issue_phase,j.intake_open,
                  j.total,j.prepared,j.issue_reviewed,j.completed,j.failed,b.suite_name,b.sequence_number
           FROM ai_analysis_jobs j JOIN run_batches b ON b.id=j.batch_id
           WHERE j.${ACTIVE_JOB} ${input.projectIds ? `AND j.project_id IN (${input.projectIds.map(() => "?").join(",")})` : ""}
           ORDER BY j.updated_at DESC,j.id DESC LIMIT ?`,
              ...(input.projectIds ?? []),
              RUNTIME_JOB_LIMIT + 1,
            ),
          );
    const [configuration, leases, admission, activeJobs] = await Promise.all([
      this.configuration(),
      this.query(
        statement(
          "SELECT job_id,stage,COUNT(*) AS count FROM ai_model_leases WHERE expires_at>? GROUP BY job_id,stage",
          input.now,
        ),
      ),
      this.query(statement("SELECT cooling_until FROM ai_model_admission WHERE id='default'")),
      jobs,
    ]);
    const countsByJob = new Map<string, { stack: number; group: number; individual: number }>();
    let activeRequests = 0;
    for (const lease of leases) {
      const count = Number(lease.count);
      activeRequests += count;
      const stage = aiModelRequestStageSchema.safeParse(lease.stage);
      if (lease.job_id === null || !stage.success) continue;
      const id = String(lease.job_id);
      const requests = countsByJob.get(id) ?? { stack: 0, group: 0, individual: 0 };
      requests[stage.data] += count;
      countsByJob.set(id, requests);
    }
    const coolingUntil = admission[0]?.cooling_until;
    return aiAnalysisRuntimeSchema.parse({
      sampledAt: input.now,
      enabled: configuration.configuration?.enabled ?? false,
      activeRequests,
      concurrencyLimit: configuration.configuration?.concurrency ?? 0,
      coolingUntil:
        typeof coolingUntil === "string" && coolingUntil > input.now ? coolingUntil : null,
      hasMoreJobs: activeJobs.length > RUNTIME_JOB_LIMIT,
      jobs: activeJobs.slice(0, RUNTIME_JOB_LIMIT).map((row) => ({
        id: String(row.id),
        batchId: String(row.batch_id),
        taskName: String(row.suite_name),
        sequenceNumber: row.sequence_number == null ? null : Number(row.sequence_number),
        single: row.attempt_id !== null,
        status: row.status,
        phase: row.strategy === AI_BATCH_CLASSIFICATION_STRATEGY ? row.issue_phase : null,
        acceptingFinalResults: Number(row.intake_open) === 1,
        total: Number(row.total),
        prepared: Number(row.prepared),
        reviewed: Number(row.issue_reviewed),
        completed: Number(row.completed),
        failed: Number(row.failed),
        requests: countsByJob.get(String(row.id)) ?? { stack: 0, group: 0, individual: 0 },
      })),
    });
  }
  async saveConfiguration(record: AiConfigurationRecord, expectedRevision: number) {
    const results = await this.write([
      statement(
        `INSERT INTO ai_model_configuration(id,revision,configuration_json,encrypted_key)
      SELECT 'default',?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM ai_model_configuration WHERE id='default' AND revision=?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, configuration_json=excluded.configuration_json,encrypted_key=excluded.encrypted_key
      WHERE ai_model_configuration.revision=? RETURNING id`,
        record.revision,
        JSON.stringify(record.configuration),
        record.encryptedKey,
        expectedRevision,
        expectedRevision,
        expectedRevision,
      ),
    ]);
    return results[0]!.length === 1;
  }
  async create(job: AiAnalysisJob, requestKey: string, options?: { followFinalResults: boolean }) {
    await this.write([
      statement(
        `INSERT INTO ai_analysis_jobs(id,batch_id,project_id,attempt_id,requested_by,request_key,status,reason,created_at,updated_at,strategy,intake_open)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(batch_id,request_key) DO NOTHING RETURNING id`,
        job.id,
        job.batchId,
        job.projectId,
        job.attemptId,
        job.requestedBy,
        requestKey,
        job.status,
        job.reason,
        job.createdAt,
        job.updatedAt,
        job.strategy ?? "legacy",
        options?.followFinalResults ? 1 : 0,
      ),
      this.wakeup(job),
    ]);
    return mapJob(
      (
        await this.query(
          statement(
            "SELECT * FROM ai_analysis_jobs WHERE batch_id=? AND request_key=?",
            job.batchId,
            requestKey,
          ),
        )
      )[0]!,
    );
  }
  async view(input: Parameters<AiAnalysisRepository["view"]>[0]) {
    const filter = input.jobId
      ? "AND j.id=?"
      : input.attemptId
        ? "AND j.attempt_id=?"
        : "AND j.attempt_id IS NULL";
    const rows = await this.query(
      statement(
        `SELECT j.* FROM ai_analysis_jobs j WHERE j.batch_id=? ${filter} ORDER BY j.created_at DESC,j.id DESC LIMIT 1`,
        input.batchId,
        ...(input.jobId ? [input.jobId] : input.attemptId ? [input.attemptId] : []),
      ),
    );
    if (!rows[0]) return null;
    const job = mapJob(rows[0]);
    const items = await this.query(
      statement(
        `SELECT * FROM ai_analysis_items WHERE job_id=? AND id>? ${input.attemptId ? "AND attempt_id=?" : ""} ORDER BY id LIMIT ?`,
        job.id,
        input.after ?? "",
        ...(input.attemptId ? [input.attemptId] : []),
        Math.min(input.limit, 100) + 1,
      ),
    );
    const groups = await this.query(
      statement(
        "SELECT * FROM ai_analysis_groups WHERE job_id=? AND id>? ORDER BY id LIMIT 6",
        job.id,
        input.groupAfter ?? "",
      ),
    );
    return {
      job,
      items: items.slice(0, input.limit).map(mapItem),
      groups: groups.slice(0, 5).map((row) => ({
        id: String(row.id),
        signature: String(row.signature),
        memberCount: Number(row.member_count),
        processed: Number(row.processed),
        status: String(row.status),
        conclusion: row.conclusion === null ? null : String(row.conclusion),
        reason: row.reason === null ? null : String(row.reason),
      })),
      ...(groups.length > 5 ? { nextGroupCursor: String(groups[4]!.id) } : {}),
      ...(items.length > input.limit ? { nextCursor: String(items[input.limit - 1]!.id) } : {}),
    };
  }
  async claimPlanning(token: string, now: string, expiresAt: string) {
    if (
      !(
        await this.query(
          statement(
            "SELECT id FROM ai_analysis_jobs WHERE status IN ('queued','preparing') AND next_intake_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<?) LIMIT 1",
            now,
            now,
          ),
        )
      ).length
    )
      return null;
    const result = await this.write([
      statement(
        `UPDATE ai_analysis_jobs SET status='preparing',lease_token=?,lease_expires_at=?,updated_at=?
      WHERE id=(SELECT id FROM ai_analysis_jobs WHERE status IN ('queued','preparing') AND next_intake_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<?) ORDER BY created_at,id LIMIT 1)
      AND status IN ('queued','preparing') AND next_intake_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<?) RETURNING *`,
        token,
        expiresAt,
        now,
        now,
        now,
        now,
        now,
      ),
    ]);
    const row = result[0]![0];
    return row
      ? {
          ...mapJob(row),
          intakeOpen: Number(row.intake_open) === 1,
          cursor: row.cursor === null ? null : String(row.cursor),
          leaseToken: token,
        }
      : null;
  }
  async candidates(job: AiPlanningJob, limit: number): Promise<AiCandidate[]> {
    const rows = await this.query(analysisCandidateQuery(job, limit));
    return rows.map((row) => ({
      executionRunId: String(row.run_id),
      attemptId: String(row.attempt_id),
      displayName: String(row.display_name),
    }));
  }
  async appendCandidates(
    job: AiPlanningJob,
    candidates: AiCandidate[],
    done: boolean,
    now: string,
  ) {
    const statements = candidates.map((candidate) =>
      statement(
        `INSERT INTO ai_analysis_items(id,job_id,execution_run_id,attempt_id,display_name,status,available_at,created_at,updated_at)
      SELECT ?,?,?,?,?,'queued',?,?,? WHERE EXISTS(SELECT 1 FROM ai_analysis_jobs WHERE id=? AND lease_token=? AND status='preparing' AND lease_expires_at>?)
      ON CONFLICT(job_id,execution_run_id) DO NOTHING RETURNING id`,
        `${job.id}:${candidate.executionRunId}`,
        job.id,
        candidate.executionRunId,
        candidate.attemptId,
        candidate.displayName,
        now,
        now,
        now,
        job.id,
        job.leaseToken,
        now,
      ),
    );
    if (done) {
      // Recheck after inserting the page: the batch may have finished since the read.
      const remaining = analysisCandidateQuery(job, 1);
      statements.push(
        statement(
          `UPDATE ai_analysis_jobs SET intake_open=0 WHERE id=? AND status='preparing' AND lease_token=? AND lease_expires_at>?
          AND EXISTS(SELECT 1 FROM run_batches b WHERE b.id=batch_id AND b.status IN ('succeeded','failed','cancelled'))
          AND NOT EXISTS(${remaining.text}) RETURNING id`,
          job.id,
          job.leaseToken,
          now,
          ...remaining.values,
        ),
        statement(
          `UPDATE ai_analysis_jobs SET groups_planned=0 WHERE id=? AND status='preparing' AND lease_token=? AND lease_expires_at>? RETURNING id`,
          job.id,
          job.leaseToken,
          now,
        ),
      );
    }
    statements.push(
      statement(
        `UPDATE ai_analysis_jobs SET cursor=?,total=(SELECT COUNT(*) FROM ai_analysis_items WHERE job_id=?),status=?,lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=?
      WHERE id=? AND lease_token=? AND status='preparing' AND lease_expires_at>? RETURNING id`,
        candidates.at(-1)?.executionRunId ?? job.cursor,
        job.id,
        done ? "analyzing" : "preparing",
        now,
        job.id,
        job.leaseToken,
        now,
      ),
    );
    if (done) {
      statements.push(this.finishJob(job.id, now, job.revision + 1));
    }
    await this.write(statements);
  }
  async claimWork(
    token: string,
    now: string,
    expiresAt: string,
    stage?: "prepare" | "infer" | "supplement",
  ): Promise<AiWork | null> {
    const eligibility = {
      prepare: `${CLAIMABLE_ITEM} AND i.evidence_key IS NULL`,
      infer: `${CLAIMABLE_ITEM} AND i.evidence_key IS NOT NULL`,
      supplement: `${OPEN_INDEPENDENT_ANALYSIS} AND i.evidence_key IS NOT NULL
        AND i.status IN ('ready','retry_wait','analyzing')`,
    };
    const eligible = stage ? eligibility[stage] : CLAIMABLE_ITEM;
    if (
      !(
        await this.query(
          statement(
            `SELECT i.id FROM ai_analysis_items i JOIN ai_analysis_jobs j ON j.id=i.job_id WHERE ${eligible} AND i.available_at<=? AND (i.lease_expires_at IS NULL OR i.lease_expires_at<?) LIMIT 1`,
            now,
            now,
          ),
        )
      ).length
    )
      return null;
    const rows = await this.write([
      statement(
        `UPDATE ai_analysis_items SET lease_token=?,lease_expires_at=?,status=CASE WHEN evidence_key IS NULL THEN 'collecting' ELSE 'analyzing' END,updated_at=?
      WHERE id=(SELECT i.id FROM ai_analysis_items i JOIN ai_analysis_jobs j ON j.id=i.job_id
        WHERE ${eligible} AND i.available_at<=?
        AND (i.lease_expires_at IS NULL OR i.lease_expires_at<?) ORDER BY i.available_at,i.id LIMIT 1)
      AND (lease_expires_at IS NULL OR lease_expires_at<?) AND ${OWNED_ITEM_JOB} RETURNING *`,
        token,
        expiresAt,
        now,
        now,
        now,
        now,
      ),
    ]);
    const row = rows[0]![0];
    if (!row) return null;
    const job = (
      await this.query(statement("SELECT * FROM ai_analysis_jobs WHERE id=?", String(row.job_id)))
    )[0]!;
    return {
      ...mapItem(row),
      strategy: mapJob(job).strategy ?? "legacy",
      projectId: String(job.project_id),
      batchId: String(job.batch_id),
      requestedBy: String(job.requested_by),
      leaseToken: token,
      evidenceKey: row.evidence_key === null ? null : String(row.evidence_key),
      attempts: Number(row.attempts),
      partCursor: Number(row.part_cursor),
      drafts: JSON.parse(String(row.drafts_json)) as AiConclusionDraft[],
    };
  }
  async renew(work: AiWork, expiresAt: string, now: string) {
    const result = await this.write([
      statement(
        `UPDATE ai_analysis_items SET lease_expires_at=? WHERE id=? AND lease_token=? AND lease_expires_at>? AND ${OWNED_ITEM_JOB} RETURNING id`,
        expiresAt,
        work.id,
        work.leaseToken,
        now,
      ),
    ]);
    return result[0]!.length > 0;
  }
  private owned(work: AiWork, now: string) {
    return statement(
      `SELECT id FROM ai_analysis_items WHERE id=? AND lease_token=? AND lease_expires_at>? AND ${OWNED_ITEM_JOB}`,
      work.id,
      work.leaseToken,
      now,
    );
  }
  async saveEvidence(work: AiWork, evidenceKey: string, signature: string, now: string) {
    const owned = this.owned(work, now);
    await this.write([
      statement(
        `UPDATE ai_analysis_jobs SET prepared=prepared+1,revision=revision+1,updated_at=? WHERE id=? AND status='analyzing' AND EXISTS(${owned.text}) RETURNING id`,
        now,
        work.jobId,
        ...owned.values,
      ),
      statement(
        `UPDATE ai_analysis_items SET evidence_key=?,signature=?,status=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id IN (${owned.text}) RETURNING id`,
        evidenceKey,
        signature,
        work.strategy === "stack_groups_v2" || work.strategy === AI_BATCH_CLASSIFICATION_STRATEGY
          ? "group_ready"
          : "ready",
        now,
        ...owned.values,
      ),
      this.finishJob(work.jobId, now),
    ]);
  }
  async saveDraft(
    work: AiWork,
    draft: AiConclusionDraft,
    cursor: number,
    conclusion: string | null,
    done: boolean,
    partial: boolean,
    now: string,
  ) {
    const owned = this.owned(work, now);
    const statements: AiSqlStatement[] = [];
    if (conclusion !== null)
      statements.push(
        statement(
          `INSERT INTO ai_analysis_conclusions(id,item_id,batch_id,attempt_id,conclusion,created_at,issue_rank)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(${owned.text}) ON CONFLICT(id) DO NOTHING RETURNING id`,
          `${work.id}:${cursor}`,
          work.id,
          work.batchId,
          work.attemptId,
          conclusion,
          now,
          work.strategy === AI_BATCH_CLASSIFICATION_STRATEGY ? 0 : null,
          ...owned.values,
        ),
      );
    if (done)
      statements.push(
        statement(
          `UPDATE ai_analysis_jobs SET completed=completed+1,failed=failed+?,revision=revision+1,updated_at=? WHERE id=? AND EXISTS(${owned.text}) RETURNING id`,
          partial ? 1 : 0,
          now,
          work.jobId,
          ...owned.values,
        ),
      );
    else
      statements.push(
        statement(
          `UPDATE ai_analysis_jobs SET revision=revision+1,updated_at=? WHERE id=? AND EXISTS(${owned.text}) RETURNING id`,
          now,
          work.jobId,
          ...owned.values,
        ),
      );
    statements.push(
      statement(
        `UPDATE ai_analysis_items SET drafts_json=?,part_cursor=?,conclusion=?,status=?,attempts=0,reason=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id IN (${owned.text}) RETURNING id`,
        JSON.stringify([draft]),
        cursor,
        conclusion,
        done ? (partial ? "partial" : "completed") : "ready",
        now,
        ...owned.values,
      ),
    );
    statements.push(this.finishJob(work.jobId, now));
    await this.write(statements);
  }
  private finishJob(jobId: string, now: string, expectedRevision?: number) {
    return statement(
      `UPDATE ai_analysis_jobs SET status=CASE
        WHEN strategy='${AI_BATCH_CLASSIFICATION_STRATEGY}' AND issue_phase='individual' THEN CASE WHEN failed>0 THEN 'partial' ELSE 'completed' END
        WHEN strategy='${AI_BATCH_CLASSIFICATION_STRATEGY}' AND intake_open=1 THEN 'queued'
        ELSE 'summarizing' END,
        next_intake_at=CASE WHEN strategy='${AI_BATCH_CLASSIFICATION_STRATEGY}' THEN CASE WHEN intake_open=1 THEN ? ELSE '' END ELSE next_intake_at END,
        revision=revision+1,updated_at=? WHERE id=? AND status='analyzing' ${expectedRevision === undefined ? "" : "AND revision=?"}
        AND CASE WHEN strategy='stack_groups_v2' OR (strategy='${AI_BATCH_CLASSIFICATION_STRATEGY}' AND issue_phase<>'individual')
          THEN NOT EXISTS(SELECT 1 FROM ai_analysis_items i WHERE i.job_id=ai_analysis_jobs.id AND i.status IN ('queued','collecting','ready','retry_wait','analyzing'))
          ELSE completed>=total END RETURNING id`,
      new Date(Date.parse(now) + 15000).toISOString(),
      now,
      jobId,
      ...(expectedRevision === undefined ? [] : [expectedRevision]),
    );
  }
  async defer(work: AiWork, reason: string, retryAt: string, failed: boolean, now: string) {
    const owned = this.owned(work, now);
    const statements: AiSqlStatement[] = [];
    if (failed)
      statements.push(
        statement(
          `UPDATE ai_analysis_jobs SET completed=completed+1,failed=failed+1,revision=revision+1,updated_at=? WHERE id=? AND EXISTS(${owned.text}) RETURNING id`,
          now,
          work.jobId,
          ...owned.values,
        ),
      );
    statements.push(
      statement(
        `UPDATE ai_analysis_items SET status=?,reason=?,attempts=attempts+1,available_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id IN (${owned.text}) RETURNING id`,
        failed ? "failed" : "retry_wait",
        reason.slice(0, 500),
        retryAt,
        now,
        ...owned.values,
      ),
    );
    statements.push(this.finishJob(work.jobId, now));
    await this.write(statements);
  }
  async cancel(jobId: string, now: string) {
    await this.write([
      statement(
        `UPDATE ai_analysis_jobs SET status='cancelled',revision=revision+1,updated_at=? WHERE id=? AND ${ACTIVE_JOB} RETURNING id`,
        now,
        jobId,
      ),
    ]);
  }
  async wait(work: AiWork, reason: string, retryAt: string, now: string) {
    await this.write([
      statement(
        `UPDATE ai_analysis_items SET status='ready',reason=?,available_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=? AND lease_expires_at>? AND ${OWNED_ITEM_JOB} RETURNING id`,
        reason,
        retryAt,
        now,
        work.id,
        work.leaseToken,
        now,
      ),
    ]);
  }
  async prepareGroups(now: string) {
    if (
      !(
        await this.query(
          statement(
            `SELECT id FROM ai_analysis_jobs WHERE status='summarizing' AND strategy<>'${AI_BATCH_CLASSIFICATION_STRATEGY}' LIMIT 1`,
          ),
        )
      ).length
    )
      return;
    await this.publishStackGroups(now);
    await this.write([
      // Intake runs only between complete analysis cycles: no live group lease is reset.
      statement(
        `UPDATE ai_analysis_groups SET member_count=(SELECT COUNT(*) FROM ai_analysis_items i WHERE i.job_id=ai_analysis_groups.job_id AND i.signature=ai_analysis_groups.signature),
        status=CASE WHEN ${REUSABLE_STACK_GROUP} THEN 'publishing' ELSE 'queued' END,
        processed=CASE WHEN ${REUSABLE_STACK_GROUP} THEN (SELECT COUNT(*) FROM ai_analysis_items i WHERE i.job_id=ai_analysis_groups.job_id AND i.signature=ai_analysis_groups.signature) ELSE 0 END,
        generation=generation+1,cursor='',part_cursor=0,publication_cursor='',attempts=0,reason=NULL,available_at=?,updated_at=?
        WHERE job_id=(SELECT id FROM ai_analysis_jobs WHERE status='summarizing' AND strategy<>'${AI_BATCH_CLASSIFICATION_STRATEGY}' AND groups_planned=0 ORDER BY created_at,id LIMIT 1)
        AND status IN ('completed','failed')
        AND member_count<(SELECT COUNT(*) FROM ai_analysis_items i WHERE i.job_id=ai_analysis_groups.job_id AND i.signature=ai_analysis_groups.signature) RETURNING id`,
        now,
        now,
      ),
      statement(
        `INSERT INTO ai_analysis_groups(id,job_id,signature,member_count,available_at,updated_at)
        SELECT j.id||':'||i.signature,j.id,i.signature,COUNT(*),?,? FROM ai_analysis_items i JOIN ai_analysis_jobs j ON j.id=i.job_id
        WHERE j.id=(SELECT id FROM ai_analysis_jobs WHERE status='summarizing' AND strategy<>'${AI_BATCH_CLASSIFICATION_STRATEGY}' AND groups_planned=0 ORDER BY created_at,id LIMIT 1)
        AND i.signature IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_analysis_groups g WHERE g.job_id=j.id AND g.signature=i.signature)
        GROUP BY j.id,i.signature ORDER BY i.signature LIMIT 50 ON CONFLICT(job_id,signature) DO NOTHING RETURNING id`,
        now,
        now,
      ),
      statement(`UPDATE ai_analysis_jobs SET groups_planned=1 WHERE id=(SELECT id FROM ai_analysis_jobs WHERE status='summarizing' AND strategy<>'${AI_BATCH_CLASSIFICATION_STRATEGY}' AND groups_planned=0 ORDER BY created_at,id LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM ai_analysis_items i WHERE i.job_id=ai_analysis_jobs.id AND i.signature IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_analysis_groups g WHERE g.job_id=i.job_id AND g.signature=i.signature)) RETURNING id`),
      this.finishGroups(now),
    ]);
  }
  async claimGroup(token: string, now: string, expiresAt: string): Promise<AiGroupWork | null> {
    const candidate = statement(
      `SELECT g.id FROM ai_analysis_groups g JOIN ai_analysis_jobs j ON j.id=g.job_id
       WHERE j.status='summarizing' AND g.status IN ('queued','running','releasing')
       AND (j.strategy<>'${AI_BATCH_CLASSIFICATION_STRATEGY}' OR j.issue_phase IN ('classify','refine'))
       AND g.available_at<=? AND (g.lease_expires_at IS NULL OR g.lease_expires_at<?)
       ORDER BY g.available_at,g.id LIMIT 1`,
      now,
      now,
    );
    if (!(await this.query(candidate)).length) return null;
    const result = await this.write([
      statement(
        `UPDATE ai_analysis_groups SET lease_token=?,lease_expires_at=?,status=CASE WHEN status='releasing' THEN status ELSE 'running' END
      WHERE id=(${candidate.text})
      AND (lease_expires_at IS NULL OR lease_expires_at<?) RETURNING *`,
        token,
        expiresAt,
        ...candidate.values,
        now,
      ),
    ]);
    const row = result[0]![0];
    if (!row) return null;
    const job = (
      await this.query(statement("SELECT * FROM ai_analysis_jobs WHERE id=?", String(row.job_id)))
    )[0]!;
    return {
      id: String(row.id),
      strategy: mapJob(job).strategy ?? "legacy",
      partCursor: Number(row.part_cursor),
      jobId: String(row.job_id),
      batchId: String(job.batch_id),
      projectId: String(job.project_id),
      requestedBy: String(job.requested_by),
      leaseToken: token,
      cursor: String(row.cursor),
      signature: String(row.signature),
      conclusion: row.conclusion === null ? null : String(row.conclusion),
      attempts: Number(row.attempts),
      processed: Number(row.processed),
      memberCount: Number(row.member_count),
      ...(typeof row.initial_summary === "string" ? { initialSummary: row.initial_summary } : {}),
      ...(row.status === "releasing" ? { releaseAfter: String(row.publication_cursor) } : {}),
      ...(typeof row.refinement_json === "string"
        ? { refinement: JSON.parse(row.refinement_json) as AiIssueRefinement }
        : {}),
    };
  }
  async groupMembers(work: AiGroupWork, limit = 1) {
    return (
      await this.query(
        statement(
          "SELECT id,display_name,conclusion,reason,evidence_key FROM ai_analysis_items WHERE job_id=? AND signature=? AND id>? ORDER BY id LIMIT ?",
          work.jobId,
          work.signature,
          work.cursor,
          Math.min(50, Math.max(1, limit)),
        ),
      )
    ).map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name),
      evidenceKey: row.evidence_key === null ? null : String(row.evidence_key),
      conclusion: row.conclusion === null ? null : String(row.conclusion),
      reason: row.reason === null ? null : String(row.reason),
    }));
  }
  async saveGroup(
    work: AiGroupWork,
    cursor: string,
    conclusion: string,
    done: boolean,
    now: string,
  ) {
    await this.write([
      statement(
        `UPDATE ai_analysis_groups SET cursor=?,conclusion=?,processed=processed+?,status=?,attempts=0,lease_token=NULL,lease_expires_at=NULL,updated_at=?
    WHERE id=? AND lease_token=? AND lease_expires_at>? AND EXISTS(SELECT 1 FROM ai_analysis_jobs WHERE id=job_id AND status='summarizing') RETURNING id`,
        cursor,
        conclusion,
        cursor === work.cursor ? 0 : 1,
        done ? "completed" : "queued",
        now,
        work.id,
        work.leaseToken,
        now,
      ),
      this.finishGroups(now),
    ]);
  }
  async groupEvidence(work: AiGroupWork) {
    const row = (
      await this.query(
        statement(
          "SELECT evidence_key FROM ai_analysis_items WHERE job_id=? AND signature=? AND evidence_key IS NOT NULL ORDER BY id LIMIT 1",
          work.jobId,
          work.signature,
        ),
      )
    )[0];
    return row ? String(row.evidence_key) : null;
  }
  async saveStackGroup(
    work: AiGroupWork,
    progress: Parameters<AiAnalysisRepository["saveStackGroup"]>[1],
    now: string,
  ) {
    await this.write([
      statement(
        `UPDATE ai_analysis_groups SET cursor=?,part_cursor=?,processed=?,conclusion=?,status=?,reason=NULL,attempts=0,lease_token=NULL,lease_expires_at=NULL,updated_at=?
      WHERE id=? AND lease_token=? AND lease_expires_at>? AND EXISTS(SELECT 1 FROM ai_analysis_jobs WHERE id=job_id AND status='summarizing') RETURNING id`,
        progress.cursor,
        progress.partCursor,
        progress.processed,
        progress.conclusion,
        progress.done ? "publishing" : "queued",
        now,
        work.id,
        work.leaseToken,
        now,
      ),
    ]);
  }
  /** Publish at most 100 members per transaction; cancellation fences all conclusions and counts. */
  private async publishStackGroups(now: string) {
    const group = (
      await this.query(
        statement(
          `SELECT g.*,j.batch_id FROM ai_analysis_groups g JOIN ai_analysis_jobs j ON j.id=g.job_id
      WHERE g.status='publishing' AND j.status='summarizing' AND j.strategy='stack_groups_v2' ORDER BY g.id LIMIT 1`,
        ),
      )
    )[0];
    if (!group) return;
    const failed = group.reason !== null;
    const items = await this.query(
      statement(
        `SELECT id,attempt_id,status FROM ai_analysis_items WHERE job_id=? AND signature=? AND id>?
          AND (?=1 OR conclusion IS NULL OR conclusion<>? OR status<>'completed') ORDER BY id LIMIT 100`,
        String(group.job_id),
        String(group.signature),
        String(group.publication_cursor),
        failed ? 1 : 0,
        group.conclusion === null ? null : String(group.conclusion),
      ),
    );
    const guard = statement(
      `SELECT id FROM ai_analysis_groups WHERE id=? AND status='publishing' AND publication_cursor=? AND generation=?
      AND EXISTS(SELECT 1 FROM ai_analysis_jobs WHERE id=job_id AND status='summarizing')`,
      String(group.id),
      String(group.publication_cursor),
      Number(group.generation),
    );
    const statements: AiSqlStatement[] = [];
    for (const item of items) {
      if (!failed)
        statements.push(
          statement(
            `INSERT INTO ai_analysis_conclusions(id,item_id,batch_id,attempt_id,conclusion,created_at)
        SELECT ?,?,?,?,?,? WHERE EXISTS(${guard.text}) ON CONFLICT(id) DO NOTHING RETURNING id`,
            `${String(item.id)}:stack-group:${String(group.generation)}`,
            String(item.id),
            String(group.batch_id),
            String(item.attempt_id),
            String(group.conclusion),
            now,
            ...guard.values,
          ),
        );
      statements.push(
        statement(
          `UPDATE ai_analysis_items SET conclusion=?,status=?,reason=?,updated_at=? WHERE id=? AND EXISTS(${guard.text}) RETURNING id`,
          failed ? null : String(group.conclusion),
          failed ? "failed" : "completed",
          failed ? String(group.reason) : null,
          now,
          String(item.id),
          ...guard.values,
        ),
      );
    }
    statements.push(
      statement(
        `UPDATE ai_analysis_jobs SET completed=completed+?,failed=failed+?,updated_at=?,revision=revision+1 WHERE id=? AND EXISTS(${guard.text}) RETURNING id`,
        items.filter((item) => !["completed", "partial", "failed"].includes(String(item.status)))
          .length,
        items.reduce(
          (delta, item) => delta + (failed ? 1 : 0) - (item.status === "failed" ? 1 : 0),
          0,
        ),
        now,
        String(group.job_id),
        ...guard.values,
      ),
    );
    statements.push(
      statement(
        `UPDATE ai_analysis_groups SET publication_cursor=?,status=?,updated_at=? WHERE id IN (${guard.text}) RETURNING id`,
        items.length ? String(items.at(-1)!.id) : String(group.publication_cursor),
        items.length < 100 ? (failed ? "failed" : "completed") : "publishing",
        now,
        ...guard.values,
      ),
    );
    statements.push(this.finishGroups(now));
    await this.write(statements);
  }
  async deferGroup(
    work: AiGroupWork,
    reason: string,
    retryAt: string,
    failed: boolean,
    now: string,
    consumeAttempt = true,
  ) {
    await this.write([
      statement(
        "UPDATE ai_analysis_groups SET reason=?,available_at=?,status=?,attempts=attempts+?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=? AND lease_expires_at>? AND EXISTS(SELECT 1 FROM ai_analysis_jobs WHERE id=job_id AND status='summarizing') RETURNING id",
        reason.slice(0, 500),
        retryAt,
        failed
          ? work.strategy === "stack_groups_v2"
            ? "publishing"
            : "failed"
          : work.releaseAfter === undefined
            ? "queued"
            : "releasing",
        consumeAttempt ? 1 : 0,
        now,
        work.id,
        work.leaseToken,
        now,
      ),
      this.finishGroups(now),
    ]);
  }
  private finishGroups(now: string) {
    return statement(
      `UPDATE ai_analysis_jobs SET status=CASE WHEN intake_open=1 THEN 'queued' WHEN failed>0 OR EXISTS(SELECT 1 FROM ai_analysis_groups g WHERE g.job_id=ai_analysis_jobs.id AND g.status='failed') THEN 'partial' ELSE 'completed' END,
        next_intake_at=CASE WHEN intake_open=1 THEN ? ELSE next_intake_at END,revision=revision+1,updated_at=?
    WHERE status='summarizing' AND strategy<>'${AI_BATCH_CLASSIFICATION_STRATEGY}' AND groups_planned=1 AND NOT EXISTS(SELECT 1 FROM ai_analysis_groups g WHERE g.job_id=ai_analysis_jobs.id AND g.status NOT IN ('completed','failed'))
      AND NOT EXISTS(SELECT 1 FROM ai_analysis_items i WHERE i.job_id=ai_analysis_jobs.id AND i.status NOT IN ('completed','partial','failed')) RETURNING id`,
      new Date(Date.parse(now) + 15000).toISOString(),
      now,
    );
  }
  async reserveModel(input: Parameters<AiAnalysisRepository["reserveModel"]>[0]) {
    const c = input.configuration;
    if (input.tokens > c.tokensPerMinute) return false;
    const results = await this.write([
      statement("DELETE FROM ai_model_leases WHERE expires_at<=? RETURNING token", input.now),
      statement(
        `UPDATE ai_model_admission SET requests=CASE WHEN window_expires_at<=? THEN 1 ELSE requests+1 END,
        tokens=CASE WHEN window_expires_at<=? THEN ? ELSE tokens+? END,
        window_expires_at=CASE WHEN window_expires_at<=? THEN ? ELSE window_expires_at END,last_token=?
        WHERE id='default' AND cooling_until<=? AND (window_expires_at<=? OR (requests<? AND tokens+?<=?))
        AND (SELECT COUNT(*) FROM ai_model_leases)<?
        AND EXISTS(SELECT 1 FROM ai_model_configuration WHERE id='default' AND revision=?) RETURNING id`,
        input.now,
        input.now,
        input.tokens,
        input.tokens,
        input.now,
        new Date(Date.parse(input.now) + 60000).toISOString(),
        input.token,
        input.now,
        input.now,
        c.requestsPerMinute,
        input.tokens,
        c.tokensPerMinute,
        c.concurrency,
        input.revision,
      ),
      statement(
        `INSERT INTO ai_model_leases(token,expires_at,job_id,stage) SELECT ?,?,?,?
         WHERE EXISTS(SELECT 1 FROM ai_model_admission WHERE id='default' AND last_token=?) RETURNING token`,
        input.token,
        input.expiresAt,
        input.work?.jobId ?? null,
        input.work?.stage ?? null,
        input.token,
      ),
    ]);
    return results[2]!.length > 0;
  }
  async releaseModel(token: string) {
    await this.write([
      statement("DELETE FROM ai_model_leases WHERE token=? RETURNING token", token),
    ]);
  }
  async coolDown(until: string) {
    await this.write([
      statement(
        "UPDATE ai_model_admission SET cooling_until=CASE WHEN cooling_until<? THEN ? ELSE cooling_until END WHERE id='default' RETURNING id",
        until,
        until,
      ),
    ]);
  }
  async source(attemptId: string) {
    return (
      (
        await this.query(
          statement(
            `SELECT a.id AS attempt_id,a.attempt_number,a.execution_round,a.result_code,a.result_summary,a.started_at,a.finished_at,a.runner_id,COALESCE(a.outcome,a.status) AS outcome,
      r.id AS execution_run_id,r.case_definition_id,r.case_version,r.display_name,r.class_name,r.case_type,r.parameters_json,
      CASE WHEN length(r.class_data_json)<=8388608 THEN r.class_data_json ELSE NULL END AS class_data_json,
      CASE WHEN length(r.class_data_json)>8388608 THEN 1 ELSE 0 END AS input_truncated,
      b.id AS batch_id,b.suite_name,b.project_id FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id JOIN run_batches b ON b.id=r.batch_id WHERE a.id=?`,
            attemptId,
          ),
        )
      )[0] ?? null
    );
  }
  async evidenceReference(jobId: string, itemId: string) {
    const row = (
      await this.query(
        statement(
          "SELECT evidence_key FROM ai_analysis_items WHERE job_id=? AND id=?",
          jobId,
          itemId,
        ),
      )
    )[0];
    return row?.evidence_key ? String(row.evidence_key) : null;
  }
  async exportClassificationJob(batchId: string, before: string) {
    const row = (
      await this.query(
        statement(
          `SELECT id FROM ai_analysis_jobs WHERE batch_id=? AND strategy='${AI_BATCH_CLASSIFICATION_STRATEGY}'
       AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT 1`,
          batchId,
          before,
        ),
      )
    )[0];
    return row ? String(row.id) : null;
  }
  async exportConclusions(
    batchId: string,
    attemptIds: string[],
    before: string,
    classificationJobId?: string,
  ) {
    if (!attemptIds.length) return [];
    const rows = await this.query(
      statement(
        `WITH selected(job_id) AS (VALUES (CAST(? AS TEXT))), candidates AS (
          SELECT c.attempt_id,c.conclusion,c.issue_rank,c.issue_summary,
            CASE WHEN i.job_id=selected.job_id THEN 1 ELSE 0 END AS current_classification,
            ROW_NUMBER() OVER (PARTITION BY c.attempt_id ORDER BY
              CASE WHEN i.job_id=selected.job_id THEN 0 ELSE 1 END,c.created_at DESC,c.id DESC) AS precedence
          FROM ai_analysis_conclusions c JOIN ai_analysis_items i ON i.id=c.item_id CROSS JOIN selected
          WHERE c.batch_id=? AND c.created_at<=?
            AND c.conclusion NOT LIKE ? AND c.attempt_id IN (${attemptIds.map(() => "?").join(",")})
        ) SELECT * FROM candidates WHERE precedence=1`,
        classificationJobId ?? null,
        batchId,
        before,
        `%${AI_INTERMEDIATE_CONCLUSION_SUFFIX}\n原因：%`,
        ...attemptIds,
      ),
    );
    return rows.map((row) => ({
      attemptId: String(row.attempt_id),
      conclusion: String(row.conclusion),
      ...(Number(row.current_classification) === 1 && row.issue_rank !== null
        ? { category: { rank: Number(row.issue_rank), summary: String(row.issue_summary ?? "") } }
        : {}),
    }));
  }
  async hasAnalysis(batchId: string, before: string) {
    return (
      (
        await this.query(
          statement(
            "SELECT id FROM ai_analysis_jobs WHERE batch_id=? AND created_at<=? LIMIT 1",
            batchId,
            before,
          ),
        )
      ).length > 0
    );
  }
  async automaticCandidates(after: string | null, limit: number) {
    const rows = await this.query(
      statement(
        `SELECT id,project_id,requested_by_username FROM run_batches WHERE (status IN ('succeeded','failed','cancelled') OR (status IN ('queued','dispatching','scheduled','running') AND (policy_json NOT LIKE '%"unlimitedRetries":true%') AND (current_round>=retry_limit+1 OR (retry_mode='immediate' AND EXISTS(SELECT 1 FROM execution_runs r WHERE r.batch_id=run_batches.id AND r.status='failed'))))) AND batch_kind='standard'
      AND id>? AND policy_json LIKE '%"aiAnalysisAfterCompletion":true%' AND policy_json LIKE ('%"aiAnalysisExecutionId":"'||id||'"%') AND NOT EXISTS(SELECT 1 FROM ai_analysis_jobs WHERE batch_id=run_batches.id AND request_key='automatic') ORDER BY id LIMIT ?`,
        after ?? "",
        limit,
      ),
    );
    return rows.map((row) => ({
      batchId: String(row.id),
      projectId: String(row.project_id),
      requestedByUsername:
        row.requested_by_username === null ? null : String(row.requested_by_username),
    }));
  }
}

function analysisCandidateQuery(job: AiPlanningJob, limit: number): AiSqlStatement {
  const attemptSelection = job.attemptId
    ? "a.id=?"
    : `a.id=(SELECT pick.id FROM run_attempts pick WHERE pick.execution_run_id=r.id
      ORDER BY CASE WHEN COALESCE(pick.outcome,pick.status)='succeeded' THEN 0 ELSE 1 END,pick.attempt_number DESC LIMIT 1)`;
  return statement(
    `SELECT r.id AS run_id,COALESCE(a.id,'') AS attempt_id,r.display_name FROM execution_runs r
      LEFT JOIN run_attempts a ON a.execution_run_id=r.id AND ${attemptSelection}
      WHERE r.batch_id=? ${
        job.intakeOpen
          ? "AND r.status IN ('failed','cancelled') AND (a.finished_at IS NOT NULL OR (a.id IS NULL AND EXISTS(SELECT 1 FROM run_batches final_batch WHERE final_batch.id=r.batch_id AND final_batch.status IN ('succeeded','failed','cancelled')))) AND NOT EXISTS(SELECT 1 FROM ai_analysis_items seen WHERE seen.job_id=? AND seen.execution_run_id=r.id)"
          : "AND r.id>?"
      } ${job.attemptId ? "AND a.id IS NOT NULL" : ""} AND COALESCE(a.outcome,a.status,r.terminal_outcome,r.status) IN ('failed','timed_out')
      ORDER BY r.id LIMIT ?`,
    ...(job.attemptId ? [job.attemptId] : []),
    job.batchId,
    job.intakeOpen ? job.id : (job.cursor ?? ""),
    limit,
  );
}

function mapJob(row: Record<string, unknown>): AiAnalysisJob {
  return {
    ...(Number(row.intake_open) === 1 ? { acceptingFinalResults: true } : {}),
    ...(row.strategy === AI_BATCH_CLASSIFICATION_STRATEGY
      ? { classificationReviewed: Number(row.issue_reviewed) }
      : {}),
    id: String(row.id),
    strategy: String(row.strategy ?? "legacy") as NonNullable<AiAnalysisJob["strategy"]>,
    batchId: String(row.batch_id),
    projectId: String(row.project_id),
    attemptId: row.attempt_id === null ? null : String(row.attempt_id),
    requestedBy: String(row.requested_by),
    status: String(row.status) as AiAnalysisJob["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    total: Number(row.total),
    prepared: Number(row.prepared),
    completed: Number(row.completed),
    failed: Number(row.failed),
    reason: row.reason === null ? null : String(row.reason),
    revision: Number(row.revision),
  };
}
function mapItem(row: Record<string, unknown>): AiAnalysisItem {
  const conclusion = row.conclusion === null ? null : String(row.conclusion);
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    executionRunId: String(row.execution_run_id),
    attemptId: String(row.attempt_id),
    displayName: String(row.display_name),
    status: String(row.status),
    signature: row.signature === null ? null : String(row.signature),
    conclusion: conclusion?.includes(`${AI_INTERMEDIATE_CONCLUSION_SUFFIX}\n原因：`)
      ? null
      : conclusion,
    reason: row.reason === null ? null : String(row.reason),
    updatedAt: String(row.updated_at),
  };
}
