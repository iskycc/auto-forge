import {
  renderPreliminaryConclusion,
  type AiGroupWork,
  type AiIssueBatchWork,
  type AiIssueCandidate,
  type AiIssueClassificationRepository,
  type AiIssueSynthesis,
} from "@autoforge/application";
import {
  AI_BATCH_CLASSIFICATION_STRATEGY,
  AI_BULK_ISSUE_MINIMUM,
  aiIssueScopeSchema,
  aiPreliminaryConclusionSchema,
  type AiPreliminaryConclusion,
} from "@autoforge/contracts";
import type { AiSql, AiSqlBatch, AiSqlStatement } from "./ai-analysis-repository";

const PLAN_PAGE = 50;
const PUBLICATION_PAGE = 100;

function mapCategory(row: Record<string, unknown>): AiIssueCandidate {
  return {
    id: String(row.id),
    summary: String(row.summary),
    conclusion: aiPreliminaryConclusionSchema.parse(JSON.parse(String(row.conclusion_json))),
    ...(typeof row.affected_subjects_json === "string"
      ? { scope: aiIssueScopeSchema.parse(JSON.parse(row.affected_subjects_json)) }
      : {}),
  };
}

function sql(text: string, ...values: AiSqlStatement["values"]): AiSqlStatement {
  return { text, values };
}

export class SqlAiIssueClassification implements AiIssueClassificationRepository {
  constructor(
    private readonly query: AiSql,
    private readonly write: AiSqlBatch,
  ) {}

  async claimBatch(
    token: string,
    now: string,
    expiresAt: string,
  ): Promise<AiIssueBatchWork | null> {
    const eligible = sql(
      `SELECT j.id FROM ai_analysis_jobs j
       WHERE j.strategy=? AND j.status='summarizing' AND j.next_intake_at<=?
       AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=?)
       AND (j.issue_phase<>'refine' OR NOT EXISTS (
         SELECT 1 FROM ai_analysis_groups g WHERE g.job_id=j.id AND g.status NOT IN ('completed','failed')
       )) ORDER BY j.updated_at,j.id LIMIT 1`,
      AI_BATCH_CLASSIFICATION_STRATEGY,
      now,
      now,
    );
    if (!(await this.query(eligible)).length) return null;
    const row = (
      await this.write([
        sql(
          `UPDATE ai_analysis_jobs SET lease_token=?,lease_expires_at=?
       WHERE id=(${eligible.text}) AND status='summarizing'
         AND (lease_expires_at IS NULL OR lease_expires_at<=?) RETURNING *`,
          token,
          expiresAt,
          ...eligible.values,
          now,
        ),
      ])
    )[0]?.[0];
    if (!row) return null;
    return {
      jobId: String(row.id),
      batchId: String(row.batch_id),
      projectId: String(row.project_id),
      requestedBy: String(row.requested_by),
      leaseToken: token,
      phase: row.issue_phase as AiIssueBatchWork["phase"],
      cursor: String(row.issue_cursor),
      attempts: Number(row.issue_attempts),
    };
  }

  private ownedBatch(work: AiIssueBatchWork, now: string) {
    return sql(
      "id=? AND status='summarizing' AND issue_phase=? AND lease_token=? AND lease_expires_at>?",
      work.jobId,
      work.phase,
      work.leaseToken,
      now,
    );
  }

  private moveBatch(
    work: AiIssueBatchWork,
    phase: AiIssueBatchWork["phase"],
    cursor: string,
    now: string,
  ) {
    const owned = this.ownedBatch(work, now);
    return sql(
      `UPDATE ai_analysis_jobs SET issue_phase=?,issue_cursor=?,issue_attempts=0,
       lease_token=NULL,lease_expires_at=NULL,reason=NULL,revision=revision+1,updated_at=?
       WHERE ${owned.text} RETURNING id`,
      phase,
      cursor,
      now,
      ...owned.values,
    );
  }

  async advanceBatch(work: AiIssueBatchWork, now: string): Promise<void> {
    switch (work.phase) {
      case "plan":
        await this.plan(work, now);
        return;
      case "refine":
        await this.write([this.moveBatch(work, "rank", "", now)]);
        return;
      case "rank":
        await this.rank(work, now);
        return;
      case "publish":
        await this.publish(work, now);
        return;
      case "classify":
        throw new Error("Stack classification requires a model verdict.");
    }
  }

  private async plan(work: AiIssueBatchWork, now: string) {
    const rows = await this.query(
      sql(
        `SELECT signature,COUNT(*) AS member_count FROM ai_analysis_items
       WHERE job_id=? AND signature>? AND status='group_ready'
       GROUP BY signature ORDER BY signature LIMIT ?`,
        work.jobId,
        work.cursor,
        PLAN_PAGE,
      ),
    );
    const owned = this.ownedBatch(work, now);
    const smallSignatures = rows
      .filter((row) => Number(row.member_count) < AI_BULK_ISSUE_MINIMUM)
      .map((row) => String(row.signature));
    await this.write([
      ...rows
        .filter((row) => Number(row.member_count) >= AI_BULK_ISSUE_MINIMUM)
        .map((row) =>
          sql(
            `INSERT INTO ai_analysis_groups(id,job_id,signature,member_count,status,available_at,updated_at)
         SELECT ?,?,?,?,'classifying',?,? WHERE EXISTS(SELECT 1 FROM ai_analysis_jobs WHERE ${owned.text})
         ON CONFLICT(job_id,signature) DO NOTHING RETURNING id`,
            `${work.jobId}:${String(row.signature)}`,
            work.jobId,
            String(row.signature),
            Number(row.member_count),
            now,
            now,
            ...owned.values,
          ),
        ),
      ...(smallSignatures.length
        ? [
            sql(
              `UPDATE ai_analysis_items SET status='ready',available_at=?,updated_at=?
               WHERE job_id=? AND status='group_ready' AND signature IN (${smallSignatures.map(() => "?").join(",")})
                 AND EXISTS(SELECT 1 FROM ai_analysis_jobs WHERE ${owned.text}) RETURNING id`,
              now,
              now,
              work.jobId,
              ...smallSignatures,
              ...owned.values,
            ),
          ]
        : []),
      this.moveBatch(
        work,
        rows.length < PLAN_PAGE ? "classify" : "plan",
        String(rows.at(-1)?.signature ?? work.cursor),
        now,
      ),
    ]);
  }

  async stacks(work: AiIssueBatchWork, limit: number) {
    return (
      await this.query(
        sql(
          `SELECT g.id,g.member_count,(SELECT i.evidence_key FROM ai_analysis_items i
          WHERE i.job_id=g.job_id AND i.signature=g.signature AND i.status='group_ready' ORDER BY i.id LIMIT 1) AS evidence_key
       FROM ai_analysis_groups g WHERE g.job_id=? AND g.status='classifying' ORDER BY g.id LIMIT ?`,
          work.jobId,
          limit,
        ),
      )
    ).map((row) => ({
      id: String(row.id),
      memberCount: Number(row.member_count),
      evidenceKey: String(row.evidence_key ?? ""),
    }));
  }

  async saveInitialClassification(
    work: AiIssueBatchWork,
    labels: ReadonlyArray<{ id: string; summary: string }>,
    now: string,
  ) {
    const owned = this.ownedBatch(work, now);
    await this.write([
      ...labels.map((label) =>
        sql(
          `UPDATE ai_analysis_groups SET initial_summary=?,status='queued',updated_at=?
         WHERE id=? AND job_id=? AND status='classifying'
         AND EXISTS(SELECT 1 FROM ai_analysis_jobs WHERE ${owned.text}) RETURNING id`,
          label.summary,
          now,
          label.id,
          work.jobId,
          ...owned.values,
        ),
      ),
      this.moveBatch(work, labels.length ? "classify" : "refine", "", now),
    ]);
  }

  async deferBatch(
    work: AiIssueBatchWork,
    reason: string,
    retryAt: string,
    failed: boolean,
    consumeAttempt: boolean,
    now: string,
  ) {
    const owned = this.ownedBatch(work, now);
    await this.write([
      sql(
        `UPDATE ai_analysis_jobs SET status=?,issue_attempts=issue_attempts+?,reason=?,next_intake_at=?,
       lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=? WHERE ${owned.text} RETURNING id`,
        failed ? "failed" : "summarizing",
        consumeAttempt ? 1 : 0,
        reason.slice(0, 500),
        retryAt,
        now,
        ...owned.values,
      ),
    ]);
  }

  async categories(work: AiGroupWork, after: string, limit: number): Promise<AiIssueCandidate[]> {
    return (
      await this.query(
        sql(
          "SELECT id,summary,conclusion_json,affected_subjects_json FROM ai_analysis_issue_categories WHERE group_id=? AND id>? ORDER BY id LIMIT ?",
          work.id,
          after,
          limit,
        ),
      )
    ).map(mapCategory);
  }

  private ownedGroup(
    work: AiGroupWork,
    now: string,
    status: "running" | "releasing" | "synthesizing" = "running",
  ) {
    return sql(
      `SELECT g.id FROM ai_analysis_groups g JOIN ai_analysis_jobs j ON j.id=g.job_id
       WHERE g.id=? AND g.lease_token=? AND g.lease_expires_at>? AND g.status=?
         AND j.status='summarizing' AND j.issue_phase IN ('classify','refine')`,
      work.id,
      work.leaseToken,
      now,
      status,
    );
  }

  async saveRefinement(
    work: AiGroupWork,
    progress: Parameters<AiIssueClassificationRepository["saveRefinement"]>[1],
    now: string,
  ) {
    const owned = this.ownedGroup(work, now);
    await this.write([
      sql(
        `UPDATE ai_analysis_groups SET part_cursor=?,refinement_json=?,status='queued',attempts=0,
       reason=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id IN (${owned.text}) RETURNING id`,
        progress.partCursor,
        JSON.stringify(progress.state),
        now,
        ...owned.values,
      ),
    ]);
  }

  async assignCategory(
    work: AiGroupWork,
    memberId: string,
    category: AiIssueCandidate,
    now: string,
    finding?: AiPreliminaryConclusion,
  ) {
    const owned = this.ownedGroup(work, now);
    await this.write([
      sql(
        `INSERT INTO ai_analysis_issue_categories(id,job_id,group_id,member_count,summary,conclusion_json,affected_subjects_json)
         SELECT ?,?,?,1,?,?,? WHERE EXISTS(${owned.text})
           AND EXISTS(SELECT 1 FROM ai_analysis_items WHERE id=? AND job_id=? AND signature=?
             AND status='group_ready' AND issue_category_id IS NULL)
         ON CONFLICT(id) DO UPDATE SET member_count=ai_analysis_issue_categories.member_count+1,
           summary=excluded.summary,conclusion_json=excluded.conclusion_json,
           affected_subjects_json=excluded.affected_subjects_json
         WHERE ai_analysis_issue_categories.group_id=excluded.group_id RETURNING id`,
        category.id,
        work.jobId,
        work.id,
        category.summary,
        JSON.stringify(category.conclusion),
        category.scope ? JSON.stringify(category.scope) : null,
        ...owned.values,
        memberId,
        work.jobId,
        work.signature,
      ),
      sql(
        `UPDATE ai_analysis_items SET issue_category_id=?,issue_finding_json=?,updated_at=? WHERE id=? AND job_id=?
         AND status='group_ready' AND issue_category_id IS NULL AND EXISTS(${owned.text}) RETURNING id`,
        category.id,
        finding ? JSON.stringify(finding) : null,
        now,
        memberId,
        work.jobId,
        ...owned.values,
      ),
      sql(
        `UPDATE ai_analysis_jobs SET issue_reviewed=issue_reviewed+1,revision=revision+1,updated_at=?
         WHERE id=? AND EXISTS(${owned.text}) AND EXISTS(SELECT 1 FROM ai_analysis_items WHERE id=? AND issue_category_id=?) RETURNING id`,
        now,
        work.jobId,
        ...owned.values,
        memberId,
        category.id,
      ),
      this.finishMember(work, memberId, now),
    ]);
  }

  async skipMember(work: AiGroupWork, memberId: string, now: string) {
    await this.write([this.finishMember(work, memberId, now)]);
  }

  private finishMember(work: AiGroupWork, memberId: string, now: string) {
    const owned = this.ownedGroup(work, now);
    return sql(
      `UPDATE ai_analysis_groups SET cursor=?,processed=processed+?,part_cursor=0,refinement_json=NULL,
       status=?,attempts=0,reason=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
       WHERE id IN (${owned.text}) RETURNING id`,
      memberId || work.cursor,
      memberId ? 1 : 0,
      !memberId || work.processed + 1 >= work.memberCount ? "releasing" : "queued",
      now,
      ...owned.values,
    );
  }

  async releaseSmallCategories(work: AiGroupWork, now: string) {
    const items = await this.query(
      sql(
        `SELECT i.id,c.member_count FROM ai_analysis_items i
         LEFT JOIN ai_analysis_issue_categories c ON c.id=i.issue_category_id
         WHERE i.job_id=? AND i.signature=? AND i.id>? AND i.status='group_ready'
         ORDER BY i.id LIMIT ?`,
        work.jobId,
        work.signature,
        work.releaseAfter!,
        PUBLICATION_PAGE,
      ),
    );
    const independent = items
      .filter((item) => Number(item.member_count ?? 0) < AI_BULK_ISSUE_MINIMUM)
      .map((item) => String(item.id));
    const owned = this.ownedGroup(work, now, "releasing");
    await this.write([
      ...(independent.length
        ? [
            sql(
              `UPDATE ai_analysis_items SET status='ready',issue_category_id=NULL,available_at=?,updated_at=?
               WHERE job_id=? AND status='group_ready' AND id IN (${independent.map(() => "?").join(",")})
                 AND EXISTS(${owned.text}) RETURNING id`,
              now,
              now,
              work.jobId,
              ...independent,
              ...owned.values,
            ),
          ]
        : []),
      sql(
        `UPDATE ai_analysis_groups SET publication_cursor=?,status=?,lease_token=NULL,lease_expires_at=NULL,
         attempts=0,reason=NULL,updated_at=? WHERE id IN (${owned.text}) RETURNING id`,
        items.length < PUBLICATION_PAGE ? "" : String(items.at(-1)!.id),
        items.length < PUBLICATION_PAGE ? "synthesizing" : "releasing",
        now,
        ...owned.values,
      ),
    ]);
  }

  async nextSynthesis(work: AiGroupWork): Promise<AiIssueSynthesis | null> {
    const [row] = await this.query(
      sql(
        `SELECT id,summary,conclusion_json,affected_subjects_json,member_count,synthesis_cursor
       FROM ai_analysis_issue_categories WHERE group_id=? AND id>? AND member_count>=?
       ORDER BY id LIMIT 1`,
        work.id,
        work.synthesisAfter!,
        AI_BULK_ISSUE_MINIMUM,
      ),
    );
    return row
      ? {
          ...mapCategory(row),
          memberCount: Number(row.member_count),
          memberCursor: String(row.synthesis_cursor),
        }
      : null;
  }

  async synthesisFindings(category: AiIssueSynthesis, limit: number) {
    return (
      await this.query(
        sql(
          `SELECT id,issue_finding_json FROM ai_analysis_items
       WHERE issue_category_id=? AND issue_finding_json IS NOT NULL AND id>? ORDER BY id LIMIT ?`,
          category.id,
          category.memberCursor,
          limit,
        ),
      )
    ).map((row) => ({
      id: String(row.id),
      conclusion: aiPreliminaryConclusionSchema.parse(JSON.parse(String(row.issue_finding_json))),
    }));
  }

  async saveSynthesis(
    work: AiGroupWork,
    now: string,
    progress?: { category: AiIssueSynthesis; memberCursor: string; complete: boolean },
  ) {
    const owned = this.ownedGroup(work, now, "synthesizing");
    await this.write([
      ...(progress
        ? [
            sql(
              `UPDATE ai_analysis_issue_categories SET summary=?,conclusion_json=?,synthesis_cursor=?,synthesis_complete=?
         WHERE id=? AND group_id=? AND EXISTS(${owned.text}) RETURNING id`,
              progress.category.summary,
              JSON.stringify(progress.category.conclusion),
              progress.memberCursor,
              progress.complete ? 1 : 0,
              progress.category.id,
              work.id,
              ...owned.values,
            ),
          ]
        : []),
      sql(
        `UPDATE ai_analysis_groups SET publication_cursor=?,status=?,lease_token=NULL,lease_expires_at=NULL,
         attempts=0,reason=NULL,updated_at=? WHERE id IN (${owned.text}) RETURNING id`,
        progress?.complete ? progress.category.id : work.synthesisAfter!,
        progress ? "synthesizing" : "completed",
        now,
        ...owned.values,
      ),
    ]);
  }

  private async rank(work: AiIssueBatchWork, now: string) {
    const rows = await this.query(
      sql(
        `SELECT c.id, (SELECT COALESCE(MAX(rank),0) FROM ai_analysis_issue_categories WHERE job_id=?)
         + ROW_NUMBER() OVER (ORDER BY c.member_count DESC,c.id) AS next_rank
       FROM ai_analysis_issue_categories c JOIN ai_analysis_groups g ON g.id=c.group_id
       WHERE c.job_id=? AND c.rank IS NULL AND c.member_count>=?
         AND (c.synthesis_complete=1 OR g.status='completed')
       ORDER BY c.member_count DESC,c.id LIMIT ?`,
        work.jobId,
        work.jobId,
        AI_BULK_ISSUE_MINIMUM,
        PLAN_PAGE,
      ),
    );
    const owned = this.ownedBatch(work, now);
    await this.write([
      ...rows.map((row) =>
        sql(
          `UPDATE ai_analysis_issue_categories SET rank=? WHERE id=? AND job_id=? AND rank IS NULL
         AND EXISTS(SELECT 1 FROM ai_analysis_jobs WHERE ${owned.text}) RETURNING id`,
          Number(row.next_rank),
          String(row.id),
          work.jobId,
          ...owned.values,
        ),
      ),
      this.moveBatch(work, rows.length < PLAN_PAGE ? "publish" : "rank", "", now),
    ]);
  }

  private async publish(work: AiIssueBatchWork, now: string) {
    const items = await this.query(
      sql(
        `SELECT i.id,i.attempt_id,c.rank,c.summary,c.conclusion_json,c.affected_subjects_json
       FROM ai_analysis_items i LEFT JOIN ai_analysis_issue_categories c ON c.id=i.issue_category_id
       WHERE i.job_id=? AND i.status='group_ready' AND i.id>? ORDER BY i.id LIMIT ?`,
        work.jobId,
        work.cursor,
        PUBLICATION_PAGE,
      ),
    );
    const owned = this.ownedBatch(work, now);
    const guard = `EXISTS(SELECT 1 FROM ai_analysis_jobs WHERE ${owned.text})`;
    const statements: AiSqlStatement[] = [];
    let completed = 0;
    for (const item of items) {
      const itemId = String(item.id);
      if (item.rank === null) {
        statements.push(
          sql(
            `UPDATE ai_analysis_items SET status='ready',issue_category_id=NULL,available_at=?,updated_at=?
           WHERE id=? AND status='group_ready' AND ${guard} RETURNING id`,
            now,
            now,
            itemId,
            ...owned.values,
          ),
        );
        continue;
      }
      const conclusion = renderPreliminaryConclusion(
        aiPreliminaryConclusionSchema.parse(JSON.parse(String(item.conclusion_json))),
        typeof item.affected_subjects_json === "string"
          ? aiIssueScopeSchema.parse(JSON.parse(item.affected_subjects_json))
          : undefined,
      );
      completed++;
      statements.push(
        sql(
          `INSERT INTO ai_analysis_conclusions(id,item_id,batch_id,attempt_id,conclusion,created_at,issue_rank,issue_summary)
           SELECT ?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(id) DO NOTHING RETURNING id`,
          `${itemId}:classified`,
          itemId,
          work.batchId,
          String(item.attempt_id),
          conclusion,
          now,
          Number(item.rank),
          String(item.summary),
          ...owned.values,
        ),
        sql(
          `UPDATE ai_analysis_items SET status='completed',conclusion=?,updated_at=?
           WHERE id=? AND status='group_ready' AND ${guard} RETURNING id`,
          conclusion,
          now,
          itemId,
          ...owned.values,
        ),
      );
    }
    const done = items.length < PUBLICATION_PAGE;
    statements.push(
      sql(
        `UPDATE ai_analysis_jobs SET completed=completed+?,issue_cursor=?,issue_phase=?,
       status=CASE WHEN ?=0 THEN 'summarizing' WHEN completed+?<total THEN 'analyzing'
         WHEN failed>0 THEN 'partial' ELSE 'completed' END,
       issue_attempts=0,reason=NULL,lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=?
       WHERE ${owned.text} RETURNING id`,
        completed,
        String(items.at(-1)?.id ?? work.cursor),
        done ? "individual" : "publish",
        done ? 1 : 0,
        completed,
        now,
        ...owned.values,
      ),
    );
    await this.write(statements);
  }
}
