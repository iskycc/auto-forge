import type {
  DdtCaseListQuery,
  DdtDeletedCase,
  DdtImportFile,
  DdtImportJob,
  DdtRepository,
} from "@autoforge/application";
import {
  DomainError,
  ddtCaseCell,
  diffDdtCaseData,
  isDdtJourney,
  type DdtCase,
  type DdtCaseData,
  type DdtCaseHistory,
  type DdtCaseTemplate,
  type DdtScope,
  type DdtTemplateFieldRule,
} from "@autoforge/domain";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { batchesOf, RELATIONAL_ID_QUERY_BATCH_SIZE } from "./database-batches";
import type { PostgresDatabaseHandle } from "./postgres-database";

type PgValue = string | number | null | string[];
type PgExecutor = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
};

export class PostgresDdtRepository implements DdtRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  private async ready(): Promise<void> {
    await this.handle.ready;
  }

  async listCases(query: DdtCaseListQuery) {
    await this.ready();
    const builder = new PgWhereBuilder(query);
    if (query.cursor) builder.add("case_id_normalized >", query.cursor);
    if (query.query)
      builder.add("case_id_normalized LIKE", `${escapeLike(normalize(query.query))}%`);
    if (query.srNum) builder.add("sr_num_normalized =", normalize(query.srNum));
    if (query.sourceName) builder.add("source_name LIKE", `%${escapeLike(query.sourceName)}%`);
    for (const filter of query.filters) builder.addFilter(filter);
    const limit = builder.value(query.limit + 1);
    const result = await this.handle.pool.query<DdtCaseSummaryRow>(
      `SELECT id, project_id, project_version_id, test_stage_id, case_id,
              case_id_normalized, sr_num, case_kind, source_name, revision, updated_at
       FROM ddt_cases WHERE ${builder.sql}
       ORDER BY case_id_normalized, id LIMIT ${limit}`,
      builder.values,
    );
    const items = result.rows.slice(0, query.limit).map(mapCaseSummary);
    const next =
      result.rows.length > query.limit
        ? result.rows[query.limit - 1]?.case_id_normalized
        : undefined;
    return { items, ...(next ? { nextCursor: next } : {}) };
  }

  async getCase(scope: DdtScope, caseId: string): Promise<DdtCase | null> {
    await this.ready();
    return getCaseWith(this.handle.pool, scope, caseId);
  }

  async getCases(scope: DdtScope, caseIds: readonly string[]): Promise<DdtCase[]> {
    await this.ready();
    return getCasesWith(this.handle.pool, scope, caseIds);
  }

  async findCaseData(scope: DdtScope, caseIds: readonly string[]) {
    return new Map(
      (await this.getCases(scope, [...new Set(caseIds.map(normalize))])).map((item) => [
        normalize(item.caseId),
        item.data,
      ]),
    );
  }

  async listGroups(scope: DdtScope, query = "", limit = 100) {
    await this.ready();
    const builder = new PgWhereBuilder(scope);
    if (query.trim()) builder.add("sr_num_normalized LIKE", `${escapeLike(normalize(query))}%`);
    const result = await this.handle.pool.query<{ sr_num: string; count: string }>(
      `SELECT MIN(sr_num) AS sr_num, COUNT(*)::text AS count
       FROM ddt_cases WHERE ${builder.sql}
       GROUP BY sr_num_normalized ORDER BY COUNT(*) DESC, sr_num_normalized
       LIMIT ${builder.value(Math.min(Math.max(limit, 1), 500))}`,
      builder.values,
    );
    return result.rows.map((row) => ({ srNum: row.sr_num, count: Number(row.count) }));
  }

  async dashboard(scope: DdtScope) {
    await this.ready();
    const today = new Date().toISOString();
    const since = new Date(Date.now() - 6 * 86_400_000).toISOString();
    const [counts, sourceCount, groups, timeline] = await Promise.all([
      this.handle.pool.query<DashboardCountRow>(
        `SELECT COUNT(*)::text AS case_count,
                COUNT(DISTINCT sr_num_normalized)::text AS group_count,
                COUNT(*) FILTER (WHERE case_kind = 'journey')::text AS journey_count,
                COUNT(*) FILTER (WHERE LEFT(created_at, 10) = LEFT($4, 10))::text AS imported_today,
                COUNT(*) FILTER (WHERE LEFT(updated_at, 10) = LEFT($4, 10)
                                  AND updated_at <> created_at)::text AS updated_today
         FROM ddt_cases WHERE project_id = $1 AND project_version_id = $2 AND test_stage_id = $3`,
        [...scopeValues(scope), today],
      ),
      this.handle.pool.query<{ value: string }>(
        `SELECT COUNT(*)::text AS value FROM ddt_import_files f
         JOIN ddt_import_jobs j ON j.id = f.job_id
         WHERE j.project_id = $1 AND j.project_version_id = $2 AND j.test_stage_id = $3
           AND f.status = 'succeeded'`,
        scopeValues(scope),
      ),
      this.listGroups(scope, "", 8),
      this.handle.pool.query<{ date: string; count: string }>(
        `SELECT LEFT(created_at, 10) AS date, COUNT(*)::text AS count
         FROM ddt_cases
         WHERE project_id = $1 AND project_version_id = $2 AND test_stage_id = $3
           AND created_at >= $4
         GROUP BY LEFT(created_at, 10) ORDER BY date`,
        [...scopeValues(scope), since],
      ),
    ]);
    const row = counts.rows[0] ?? emptyDashboardCounts;
    return {
      caseCount: Number(row.case_count),
      groupCount: Number(row.group_count),
      sourceCount: Number(sourceCount.rows[0]?.value ?? 0),
      journeyCount: Number(row.journey_count),
      importedToday: Number(row.imported_today),
      updatedToday: Number(row.updated_today),
      groups,
      timeline: timeline.rows.map((item) => ({ date: item.date, count: Number(item.count) })),
    };
  }

  async exportCases(selection: DdtScope & { caseIds?: string[]; srNum?: string }) {
    await this.ready();
    const builder = new PgWhereBuilder(selection);
    if (selection.srNum) builder.add("sr_num_normalized =", normalize(selection.srNum));
    if (selection.caseIds?.length)
      builder.add("case_id_normalized = ANY", selection.caseIds.map(normalize), "($n::text[])");
    const result = await this.handle.pool.query<{ data_json: string }>(
      `SELECT data_json FROM ddt_cases WHERE ${builder.sql} ORDER BY case_id_normalized`,
      builder.values,
    );
    return result.rows.map((row) => parseCaseData(row.data_json));
  }

  async updateCases(records: Parameters<DdtRepository["updateCases"]>[0]): Promise<DdtCase[]> {
    if (records.length === 0) return [];
    await this.ready();
    await transaction(this.handle, async (client) => {
      for (const record of records) {
        const currentResult = await client.query<{
          id: string;
          case_id: string;
          data_json: string;
          revision: number;
        }>(
          `SELECT id, case_id, data_json, revision FROM ddt_cases
           WHERE project_id = $1 AND project_version_id = $2 AND test_stage_id = $3
             AND case_id_normalized = $4 FOR UPDATE`,
          [...scopeValues(record.scope), normalize(record.caseId)],
        );
        const current = currentResult.rows[0];
        if (!current) throw new DomainError("DDT_CASE_NOT_FOUND", "指定的 DDT 用例不存在。");
        if (current.revision !== record.expectedRevision) revisionConflict();
        const before = parseCaseData(current.data_json);
        const nextCaseId = String(ddtCaseCell(record.nextData, "CaseID"));
        const nextSrNum = String(ddtCaseCell(record.nextData, "srNum"));
        const duplicate = await client.query(
          `SELECT 1 FROM ddt_cases
           WHERE project_id = $1 AND project_version_id = $2 AND test_stage_id = $3
             AND case_id_normalized = $4 AND id <> $5 LIMIT 1`,
          [...scopeValues(record.scope), normalize(nextCaseId), current.id],
        );
        if (duplicate.rowCount) {
          throw new DomainError(
            "DDT_CASE_ID_CONFLICT",
            `CaseID“${nextCaseId}”已存在，请使用其他标识。`,
          );
        }
        const updated = await client.query(
          `UPDATE ddt_cases SET case_id = $1, case_id_normalized = $2, sr_num = $3,
             sr_num_normalized = $4, case_kind = $5, data_json = $6, revision = revision + 1,
             updated_by = $7, updated_at = $8 WHERE id = $9 AND revision = $10`,
          [
            nextCaseId,
            normalize(nextCaseId),
            nextSrNum,
            normalize(nextSrNum),
            isDdtJourney(record.nextData) ? "journey" : "standard",
            JSON.stringify(record.nextData),
            record.actorId ?? null,
            record.updatedAt,
            current.id,
            record.expectedRevision,
          ],
        );
        if (updated.rowCount !== 1) revisionConflict();
        await client.query(
          `INSERT INTO ddt_case_history
           (id, ddt_case_id, case_id, change_type, actor_id, source_name,
            before_json, after_json, changes_json, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            record.historyId,
            current.id,
            nextCaseId,
            record.historyType,
            record.actorId ?? null,
            record.sourceName,
            JSON.stringify(before),
            JSON.stringify(record.nextData),
            JSON.stringify(diffDdtCaseData(before, record.nextData)),
            record.updatedAt,
          ],
        );
      }
    });
    return this.getCases(
      records[0]!.scope,
      records.map((record) => String(ddtCaseCell(record.nextData, "CaseID"))),
    );
  }

  async trashCases(input: Parameters<DdtRepository["trashCases"]>[0]): Promise<number> {
    await this.ready();
    return transaction(this.handle, async (client) => {
      const cases = await getCasesWith(client, input.scope, input.caseIds, true);
      if (cases.length !== input.caseIds.length)
        throw new DomainError("DDT_CASE_NOT_FOUND", "删除选择中包含不存在的 DDT 用例。");
      for (const [index, item] of cases.entries()) {
        await client.query(
          `INSERT INTO ddt_deleted_cases
           (id, ddt_case_id, project_id, project_version_id, test_stage_id, case_id,
            case_id_normalized, sr_num, sr_num_normalized, case_kind, data_json,
            source_file_id, source_name, case_created_at, case_updated_at, deleted_by, deleted_at)
           SELECT $1, id, project_id, project_version_id, test_stage_id, case_id,
                  case_id_normalized, sr_num, sr_num_normalized, case_kind, data_json,
                  source_file_id, source_name, created_at, updated_at, $2, $3
           FROM ddt_cases WHERE id = $4`,
          [input.recycleIds[index], input.actorId ?? null, input.deletedAt, item.id],
        );
        await client.query("DELETE FROM ddt_cases WHERE id = $1", [item.id]);
      }
      return cases.length;
    });
  }

  async listDeletedCases(input: DdtScope & { query?: string; cursor?: string; limit: number }) {
    await this.ready();
    const builder = new PgWhereBuilder(input);
    if (input.query) {
      const pattern = `%${escapeLike(normalize(input.query))}%`;
      const value = builder.value(pattern);
      builder.raw(`(case_id_normalized LIKE ${value} OR sr_num_normalized LIKE ${value})`);
    }
    if (input.cursor) builder.add("id <", input.cursor);
    const result = await this.handle.pool.query<DeletedSummaryRow>(
      `SELECT id, ddt_case_id, project_id, project_version_id, test_stage_id,
              case_id, sr_num, source_name, deleted_at, deleted_by
       FROM ddt_deleted_cases WHERE ${builder.sql}
       ORDER BY id DESC LIMIT ${builder.value(input.limit + 1)}`,
      builder.values,
    );
    const items = result.rows.slice(0, input.limit).map(mapDeletedSummary);
    const next = result.rows.length > input.limit ? items.at(-1)?.id : undefined;
    return { items, ...(next ? { nextCursor: next } : {}) };
  }

  async restoreDeletedCase(input: Parameters<DdtRepository["restoreDeletedCase"]>[0]) {
    await this.ready();
    let caseId = "";
    await transaction(this.handle, async (client) => {
      const result = await client.query<DeletedCaseRow>(
        `SELECT * FROM ddt_deleted_cases WHERE id = $1 AND project_id = $2
         AND project_version_id = $3 AND test_stage_id = $4 FOR UPDATE`,
        [input.recycleId, ...scopeValues(input.scope)],
      );
      const row = result.rows[0];
      if (!row) throw new DomainError("DDT_RECYCLE_NOT_FOUND", "回收站记录不存在。");
      caseId = row.case_id;
      const duplicate = await client.query(
        `SELECT 1 FROM ddt_cases WHERE project_id = $1 AND project_version_id = $2
         AND test_stage_id = $3 AND case_id_normalized = $4 LIMIT 1`,
        [...scopeValues(input.scope), row.case_id_normalized],
      );
      if (duplicate.rowCount)
        throw new DomainError("DDT_CASE_ID_CONFLICT", `CaseID“${row.case_id}”已存在，无法恢复。`);
      await client.query(
        `INSERT INTO ddt_cases
         (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized,
          sr_num, sr_num_normalized, case_kind, data_json, source_file_id, source_name,
          revision, created_by, updated_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$13,$14,$15)`,
        [
          row.ddt_case_id,
          row.project_id,
          row.project_version_id,
          row.test_stage_id,
          row.case_id,
          row.case_id_normalized,
          row.sr_num,
          row.sr_num_normalized,
          row.case_kind,
          row.data_json,
          row.source_file_id,
          row.source_name,
          input.actorId ?? null,
          row.case_created_at,
          input.restoredAt,
        ],
      );
      await client.query("DELETE FROM ddt_deleted_cases WHERE id = $1", [input.recycleId]);
    });
    const restored = await this.getCase(input.scope, caseId);
    if (!restored) throw new Error("Restored DDT case was not found.");
    return restored;
  }

  async purgeDeletedCase(scope: DdtScope, recycleId: string): Promise<boolean> {
    await this.ready();
    const result = await this.handle.pool.query(
      `DELETE FROM ddt_deleted_cases WHERE id = $1 AND project_id = $2
       AND project_version_id = $3 AND test_stage_id = $4`,
      [recycleId, ...scopeValues(scope)],
    );
    return result.rowCount === 1;
  }

  async listHistory(input: DdtScope & { caseId: string; cursor?: string; limit: number }) {
    const item = await this.getCase(input, input.caseId);
    if (!item) return { items: [] };
    const values: PgValue[] = [item.id];
    const cursor = input.cursor ? `AND id < $${values.push(input.cursor)}` : "";
    const result = await this.handle.pool.query<HistoryRow>(
      `SELECT id, ddt_case_id, case_id, change_type, actor_id, source_name,
              before_json, after_json, changes_json, created_at
       FROM ddt_case_history WHERE ddt_case_id = $1 ${cursor}
       ORDER BY id DESC LIMIT $${values.push(input.limit + 1)}`,
      values,
    );
    const items = result.rows.slice(0, input.limit).map(mapHistory);
    const next = result.rows.length > input.limit ? items.at(-1)?.id : undefined;
    return { items, ...(next ? { nextCursor: next } : {}) };
  }

  async getHistory(scope: DdtScope, caseId: string, historyId: string) {
    const item = await this.getCase(scope, caseId);
    if (!item) return null;
    const result = await this.handle.pool.query<HistoryRow>(
      `SELECT id, ddt_case_id, case_id, change_type, actor_id, source_name,
              before_json, after_json, changes_json, created_at
       FROM ddt_case_history WHERE id = $1 AND ddt_case_id = $2 LIMIT 1`,
      [historyId, item.id],
    );
    return result.rows[0] ? mapHistory(result.rows[0]) : null;
  }

  async listTemplates(scope: DdtScope): Promise<DdtCaseTemplate[]> {
    await this.ready();
    const result = await this.handle.pool.query<TemplateRow>(
      `${templateSelect()} WHERE project_id = $1 AND project_version_id = $2 AND test_stage_id = $3
       ORDER BY sr_num_normalized`,
      scopeValues(scope),
    );
    return result.rows.map(mapTemplate);
  }

  async getTemplateForSrNum(scope: DdtScope, srNum: string) {
    await this.ready();
    const result = await this.handle.pool.query<TemplateRow>(
      `${templateSelect()} WHERE project_id = $1 AND project_version_id = $2 AND test_stage_id = $3
       AND sr_num_normalized = $4 LIMIT 1`,
      [...scopeValues(scope), normalize(srNum)],
    );
    return result.rows[0] ? mapTemplate(result.rows[0]) : null;
  }

  async writeTemplate(record: Parameters<DdtRepository["writeTemplate"]>[0]) {
    await this.ready();
    if (record.expectedRevision !== undefined) {
      const result = await this.handle.pool.query(
        `UPDATE ddt_case_templates SET sr_num = $1, sr_num_normalized = $2, name = $3,
           description = $4, rules_json = $5, revision = revision + 1,
           updated_by = $6, updated_at = $7
         WHERE id = $8 AND project_id = $9 AND project_version_id = $10
           AND test_stage_id = $11 AND revision = $12`,
        [
          record.srNum,
          normalize(record.srNum),
          record.name,
          record.description,
          JSON.stringify(record.rules),
          record.actorId ?? null,
          record.now,
          record.id,
          ...scopeValues(record),
          record.expectedRevision,
        ],
      );
      if (result.rowCount !== 1)
        throw new DomainError(
          "DDT_TEMPLATE_REVISION_CONFLICT",
          "字段模板已被他人修改，请刷新后重试。",
        );
    } else {
      await this.handle.pool.query(
        `INSERT INTO ddt_case_templates
         (id, project_id, project_version_id, test_stage_id, sr_num, sr_num_normalized,
          name, description, rules_json, revision, created_by, updated_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$10,$11,$11)`,
        [
          record.id,
          ...scopeValues(record),
          record.srNum,
          normalize(record.srNum),
          record.name,
          record.description,
          JSON.stringify(record.rules),
          record.actorId ?? null,
          record.now,
        ],
      );
    }
    const item = (await this.listTemplates(record)).find((template) => template.id === record.id);
    if (!item) throw new Error("DDT template was not persisted.");
    return item;
  }

  async deleteTemplate(scope: DdtScope, templateId: string, expectedRevision: number) {
    await this.ready();
    const result = await this.handle.pool.query(
      `DELETE FROM ddt_case_templates WHERE id = $1 AND project_id = $2
       AND project_version_id = $3 AND test_stage_id = $4 AND revision = $5`,
      [templateId, ...scopeValues(scope), expectedRevision],
    );
    return result.rowCount === 1;
  }

  async createImportPreview(input: Parameters<DdtRepository["createImportPreview"]>[0]) {
    await this.ready();
    await transaction(this.handle, async (client) => {
      const job = input.job;
      await client.query(
        `INSERT INTO ddt_import_jobs
         (id, project_id, project_version_id, test_stage_id, status, uploads_json,
          progress_percent, total_files, valid_files, total_rows, inserted_count,
          updated_count, unchanged_count, skipped_count, failed_files, requested_by,
          created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          job.id,
          ...scopeValues(job),
          job.status,
          JSON.stringify(job.uploads),
          job.progressPercent,
          job.totalFiles,
          job.validFiles,
          job.totalRows,
          job.insertedCount,
          job.updatedCount,
          job.unchangedCount,
          job.skippedCount,
          job.failedFiles,
          job.requestedBy ?? null,
          job.createdAt,
          job.updatedAt,
        ],
      );
      for (const file of input.files) {
        await client.query(
          `INSERT INTO ddt_import_files
           (id, job_id, upload_id, file_name, archive_entry_name, status, row_count,
            inserted_count, updated_count, unchanged_count, skipped_count, error_summary,
            created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13)`,
          [
            file.id,
            job.id,
            file.uploadId,
            file.fileName,
            file.archiveEntryName ?? null,
            file.errorSummary ? "excluded" : "valid",
            file.rowCount,
            file.insertedCount,
            file.updatedCount,
            file.unchangedCount,
            file.errorSummary ?? null,
            job.createdAt,
            job.updatedAt,
          ],
        );
      }
    });
    const job = await this.getImportJob(input.job.id);
    if (!job) throw new Error("DDT import preview was not persisted.");
    return job;
  }

  async confirmImport(input: Parameters<DdtRepository["confirmImport"]>[0]) {
    await this.ready();
    if (input.projectIds?.length === 0)
      throw new DomainError("DDT_IMPORT_NOT_FOUND", "导入任务不存在。");
    await transaction(this.handle, async (client) => {
      const values: PgValue[] = [input.conflictStrategy, input.updatedAt, input.jobId];
      const scope = input.projectIds
        ? `AND project_id = ANY($${values.push([...input.projectIds])}::text[])`
        : "";
      const updated = await client.query(
        `UPDATE ddt_import_jobs SET status = 'queued', conflict_strategy = $1, updated_at = $2
         WHERE id = $3 AND status = 'previewed' AND valid_files > 0 ${scope}`,
        values,
      );
      if (updated.rowCount !== 1)
        throw new DomainError(
          "DDT_IMPORT_STATE_CONFLICT",
          "导入预检不存在、没有有效表格或已启动。",
        );
      await client.query(
        `INSERT INTO transactional_outbox
         (message_id, run_id, attempt, schema_version, subject, payload_json,
          deduplication_key, created_at, available_at)
         VALUES ($1,$2,$3,$4,'autoforge.jobs.v1.ready',$5::jsonb,$6,$7,$7)`,
        [
          input.dispatchJob.messageId,
          input.dispatchJob.runId,
          input.dispatchJob.attempt,
          input.dispatchJob.schemaVersion,
          JSON.stringify(input.dispatchJob),
          input.dispatchJob.deduplicationKey,
          input.dispatchJob.createdAt,
        ],
      );
    });
    const job = await this.getImportJob(input.jobId, input.projectIds);
    if (!job) throw new Error("Confirmed DDT import job was not found.");
    return job;
  }

  async getImportJob(jobId: string, projectIds?: readonly string[]) {
    await this.ready();
    if (projectIds?.length === 0) return null;
    const values: PgValue[] = [jobId];
    const scope = projectIds
      ? `AND project_id = ANY($${values.push([...projectIds])}::text[])`
      : "";
    const result = await this.handle.pool.query<ImportJobRow>(
      `SELECT * FROM ddt_import_jobs WHERE id = $1 ${scope} LIMIT 1`,
      values,
    );
    return result.rows[0] ? this.mapImportJob(result.rows[0]) : null;
  }

  async listImportJobs(input: DdtScope & { cursor?: string; limit: number }) {
    await this.ready();
    const values: PgValue[] = [...scopeValues(input)];
    const cursor = input.cursor ? `AND id < $${values.push(input.cursor)}` : "";
    const result = await this.handle.pool.query<ImportJobRow>(
      `SELECT * FROM ddt_import_jobs WHERE project_id = $1 AND project_version_id = $2
       AND test_stage_id = $3 ${cursor} ORDER BY id DESC LIMIT $${values.push(input.limit + 1)}`,
      values,
    );
    const items = await Promise.all(
      result.rows.slice(0, input.limit).map((row) => this.mapImportJob(row)),
    );
    const next = result.rows.length > input.limit ? items.at(-1)?.id : undefined;
    return { items, ...(next ? { nextCursor: next } : {}) };
  }

  async claimImportJob(jobId: string, startedAt: string) {
    await this.ready();
    const result = await this.handle.pool.query(
      `UPDATE ddt_import_jobs SET status = 'running', progress_percent = 1,
       started_at = COALESCE(started_at, $1), updated_at = $1
       WHERE id = $2 AND status IN ('queued', 'running')`,
      [startedAt, jobId],
    );
    return result.rowCount === 1 ? this.getImportJob(jobId) : null;
  }

  async requestImportCancellation(
    jobId: string,
    updatedAt: string,
    projectIds?: readonly string[],
  ) {
    await this.ready();
    if (projectIds?.length === 0) throw new DomainError("DDT_IMPORT_NOT_FOUND", "导入任务不存在。");
    const values: PgValue[] = [updatedAt, jobId];
    const scope = projectIds
      ? `AND project_id = ANY($${values.push([...projectIds])}::text[])`
      : "";
    const result = await this.handle.pool.query(
      `UPDATE ddt_import_jobs
       SET status = CASE WHEN status IN ('previewed','queued') THEN 'cancelled'
                         ELSE 'cancel_requested' END,
           progress_percent = CASE WHEN status IN ('previewed','queued') THEN 100 ELSE progress_percent END,
           finished_at = CASE WHEN status IN ('previewed','queued') THEN $1 ELSE finished_at END,
           updated_at = $1
       WHERE id = $2 AND status IN ('previewed','queued','running') ${scope}`,
      values,
    );
    if (result.rowCount !== 1)
      throw new DomainError("DDT_IMPORT_STATE_CONFLICT", "导入任务无法取消。");
    const job = await this.getImportJob(jobId, projectIds);
    if (!job) throw new Error("Cancelled DDT import job was not found.");
    return job;
  }

  async updateImportJob(input: Parameters<DdtRepository["updateImportJob"]>[0]) {
    const current = await this.getImportJob(input.jobId);
    if (!current) throw new Error(`DDT import job ${input.jobId} does not exist.`);
    await this.handle.pool.query(
      `UPDATE ddt_import_jobs SET status = $1, progress_percent = $2, inserted_count = $3,
       updated_count = $4, unchanged_count = $5, skipped_count = $6, failed_files = $7,
       error_code = $8, error_summary = $9, updated_at = $10, finished_at = $11 WHERE id = $12`,
      [
        input.status,
        input.progressPercent,
        input.insertedCount ?? current.insertedCount,
        input.updatedCount ?? current.updatedCount,
        input.unchangedCount ?? current.unchangedCount,
        input.skippedCount ?? current.skippedCount,
        input.failedFiles ?? current.failedFiles,
        input.errorCode ?? current.errorCode ?? null,
        input.errorSummary ?? current.errorSummary ?? null,
        input.updatedAt,
        input.finishedAt ?? current.finishedAt ?? null,
        input.jobId,
      ],
    );
    const job = await this.getImportJob(input.jobId);
    if (!job) throw new Error("Updated DDT import job was not found.");
    return job;
  }

  async updateImportFile(input: Parameters<DdtRepository["updateImportFile"]>[0]) {
    await this.ready();
    await this.handle.pool.query(
      `UPDATE ddt_import_files SET status = $1,
       inserted_count = COALESCE($2, inserted_count), updated_count = COALESCE($3, updated_count),
       unchanged_count = COALESCE($4, unchanged_count), skipped_count = COALESCE($5, skipped_count),
       error_summary = $6, updated_at = $7 WHERE id = $8`,
      [
        input.status,
        input.result?.insertedCount ?? null,
        input.result?.updatedCount ?? null,
        input.result?.unchangedCount ?? null,
        input.result?.skippedCount ?? null,
        input.errorSummary ?? null,
        input.updatedAt,
        input.fileId,
      ],
    );
  }

  async importFile(input: Parameters<DdtRepository["importFile"]>[0]) {
    await this.ready();
    return transaction(this.handle, async (client) => {
      const result = {
        insertedCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        skippedCount: 0,
        caseIds: [] as Array<{
          caseId: string;
          outcome: "inserted" | "updated" | "unchanged" | "skipped";
        }>,
      };
      for (const [index, row] of input.rows.entries()) {
        const normalizedCaseId = normalize(row.caseId);
        const existingResult = await client.query<{ id: string; data_json: string }>(
          `SELECT id, data_json FROM ddt_cases WHERE project_id = $1 AND project_version_id = $2
           AND test_stage_id = $3 AND case_id_normalized = $4 FOR UPDATE`,
          [...scopeValues(input.scope), normalizedCaseId],
        );
        const existing = existingResult.rows[0];
        let outcome: "inserted" | "updated" | "unchanged" | "skipped";
        if (!existing) {
          await client.query(
            `INSERT INTO ddt_cases
             (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized,
              sr_num, sr_num_normalized, case_kind, data_json, source_file_id, source_name,
              revision, created_by, updated_by, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$13,$14,$14)`,
            [
              row.id,
              ...scopeValues(input.scope),
              row.caseId,
              normalizedCaseId,
              row.srNum,
              normalize(row.srNum),
              isDdtJourney(row.data) ? "journey" : "standard",
              JSON.stringify(row.data),
              input.fileId,
              input.sourceName,
              input.actorId ?? null,
              input.importedAt,
            ],
          );
          result.insertedCount += 1;
          outcome = "inserted";
        } else {
          const before = parseCaseData(existing.data_json);
          if (JSON.stringify(before) === JSON.stringify(row.data)) {
            result.unchangedCount += 1;
            outcome = "unchanged";
          } else if (input.conflictStrategy === "skip") {
            result.skippedCount += 1;
            outcome = "skipped";
          } else if (input.conflictStrategy === "error") {
            throw new DomainError("DDT_IMPORT_CONFLICT", `CaseID“${row.caseId}”已存在。`);
          } else {
            await client.query(
              `UPDATE ddt_cases SET case_id = $1, sr_num = $2, sr_num_normalized = $3,
               case_kind = $4, data_json = $5, source_file_id = $6, source_name = $7,
               revision = revision + 1, updated_by = $8, updated_at = $9 WHERE id = $10`,
              [
                row.caseId,
                row.srNum,
                normalize(row.srNum),
                isDdtJourney(row.data) ? "journey" : "standard",
                JSON.stringify(row.data),
                input.fileId,
                input.sourceName,
                input.actorId ?? null,
                input.importedAt,
                existing.id,
              ],
            );
            await client.query(
              `INSERT INTO ddt_case_history
               (id, ddt_case_id, case_id, change_type, actor_id, source_name,
                before_json, after_json, changes_json, created_at)
               VALUES ($1,$2,$3,'import_overwrite',$4,$5,$6,$7,$8,$9)`,
              [
                input.historyIds[index],
                existing.id,
                row.caseId,
                input.actorId ?? null,
                input.sourceName,
                JSON.stringify(before),
                JSON.stringify(row.data),
                JSON.stringify(diffDdtCaseData(before, row.data)),
                input.importedAt,
              ],
            );
            result.updatedCount += 1;
            outcome = "updated";
          }
        }
        result.caseIds.push({ caseId: row.caseId, outcome });
        await client.query(
          `INSERT INTO ddt_import_case_ids(job_id, case_id, case_id_normalized, outcome, created_at)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT(job_id, case_id_normalized) DO UPDATE
           SET case_id = EXCLUDED.case_id, outcome = EXCLUDED.outcome`,
          [input.jobId, row.caseId, normalizedCaseId, outcome, input.importedAt],
        );
      }
      await client.query(
        `UPDATE ddt_import_files SET status = 'succeeded', inserted_count = $1,
         updated_count = $2, unchanged_count = $3, skipped_count = $4,
         error_summary = NULL, updated_at = $5 WHERE id = $6 AND job_id = $7`,
        [
          result.insertedCount,
          result.updatedCount,
          result.unchangedCount,
          result.skippedCount,
          input.importedAt,
          input.fileId,
          input.jobId,
        ],
      );
      return result;
    });
  }

  async listImportCaseIds(jobId: string, projectIds?: readonly string[]) {
    const job = await this.getImportJob(jobId, projectIds);
    if (!job) throw new DomainError("DDT_IMPORT_NOT_FOUND", "导入任务不存在。");
    const result = await this.handle.pool.query<{
      case_id: string;
      outcome: "inserted" | "updated" | "unchanged" | "skipped";
    }>(
      `SELECT case_id, outcome FROM ddt_import_case_ids WHERE job_id = $1 ORDER BY case_id_normalized`,
      [jobId],
    );
    return result.rows.map((row) => ({ caseId: row.case_id, outcome: row.outcome }));
  }

  private async mapImportJob(row: ImportJobRow): Promise<DdtImportJob> {
    const result = await this.handle.pool.query<ImportFileRow>(
      `SELECT id, job_id, upload_id, file_name, archive_entry_name, status, row_count,
              inserted_count, updated_count, unchanged_count, skipped_count, error_summary,
              created_at, updated_at
       FROM ddt_import_files WHERE job_id = $1 ORDER BY created_at, id`,
      [row.id],
    );
    return {
      id: row.id,
      projectId: row.project_id,
      projectVersionId: row.project_version_id,
      testStageId: row.test_stage_id,
      status: row.status,
      ...(row.conflict_strategy ? { conflictStrategy: row.conflict_strategy } : {}),
      uploads: parseUploads(row.uploads_json),
      files: result.rows.map(mapImportFile),
      progressPercent: row.progress_percent,
      totalFiles: row.total_files,
      validFiles: row.valid_files,
      totalRows: row.total_rows,
      insertedCount: row.inserted_count,
      updatedCount: row.updated_count,
      unchangedCount: row.unchanged_count,
      skippedCount: row.skipped_count,
      failedFiles: row.failed_files,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
      ...(row.requested_by ? { requestedBy: row.requested_by } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    };
  }
}

type DdtCaseRow = {
  id: string;
  project_id: string;
  project_version_id: string;
  test_stage_id: string;
  case_id: string;
  sr_num: string;
  case_kind: "standard" | "journey";
  data_json: string;
  source_name: string;
  revision: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
};

type DdtCaseSummaryRow = Omit<DdtCaseRow, "data_json" | "created_at" | "updated_by"> & {
  case_id_normalized: string;
};

type HistoryRow = {
  id: string;
  ddt_case_id: string;
  case_id: string;
  change_type: DdtCaseHistory["changeType"];
  actor_id: string | null;
  source_name: string;
  before_json: string;
  after_json: string;
  changes_json: string;
  created_at: string;
};

type TemplateRow = {
  id: string;
  project_id: string;
  project_version_id: string;
  test_stage_id: string;
  sr_num: string;
  name: string;
  description: string;
  rules_json: string;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

type ImportFileRow = {
  id: string;
  job_id: string;
  upload_id: string;
  file_name: string;
  archive_entry_name: string | null;
  status: DdtImportFile["status"];
  row_count: number;
  inserted_count: number;
  updated_count: number;
  unchanged_count: number;
  skipped_count: number;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
};

type ImportJobRow = {
  id: string;
  project_id: string;
  project_version_id: string;
  test_stage_id: string;
  status: DdtImportJob["status"];
  conflict_strategy: DdtImportJob["conflictStrategy"] | null;
  uploads_json: string;
  progress_percent: number;
  total_files: number;
  valid_files: number;
  total_rows: number;
  inserted_count: number;
  updated_count: number;
  unchanged_count: number;
  skipped_count: number;
  failed_files: number;
  error_code: string | null;
  error_summary: string | null;
  requested_by: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type DeletedSummaryRow = {
  id: string;
  ddt_case_id: string;
  project_id: string;
  project_version_id: string;
  test_stage_id: string;
  case_id: string;
  sr_num: string;
  source_name: string;
  deleted_at: string;
  deleted_by: string | null;
};

type DeletedCaseRow = {
  ddt_case_id: string;
  project_id: string;
  project_version_id: string;
  test_stage_id: string;
  case_id: string;
  case_id_normalized: string;
  sr_num: string;
  sr_num_normalized: string;
  case_kind: "standard" | "journey";
  data_json: string;
  source_file_id: string | null;
  source_name: string;
  case_created_at: string;
  case_updated_at: string;
};

type DashboardCountRow = {
  case_count: string;
  group_count: string;
  journey_count: string;
  imported_today: string;
  updated_today: string;
};

const emptyDashboardCounts: DashboardCountRow = {
  case_count: "0",
  group_count: "0",
  journey_count: "0",
  imported_today: "0",
  updated_today: "0",
};

const caseSelect = `SELECT id, project_id, project_version_id, test_stage_id, case_id,
  sr_num, case_kind, data_json, source_name, revision, created_at, updated_at, updated_by
  FROM ddt_cases`;

async function getCaseWith(executor: PgExecutor, scope: DdtScope, caseId: string) {
  const result = await executor.query<DdtCaseRow>(
    `${caseSelect} WHERE project_id = $1 AND project_version_id = $2 AND test_stage_id = $3
     AND case_id_normalized = $4 LIMIT 1`,
    [...scopeValues(scope), normalize(caseId)],
  );
  return result.rows[0] ? mapCase(result.rows[0]) : null;
}

async function getCasesWith(
  executor: PgExecutor,
  scope: DdtScope,
  caseIds: readonly string[],
  lock = false,
): Promise<DdtCase[]> {
  if (caseIds.length === 0) return [];
  const byId = new Map<string, DdtCase>();
  for (const ids of batchesOf(caseIds.map(normalize), RELATIONAL_ID_QUERY_BATCH_SIZE)) {
    const result = await executor.query<DdtCaseRow>(
      `${caseSelect} WHERE project_id = $1 AND project_version_id = $2 AND test_stage_id = $3
       AND case_id_normalized = ANY($4::text[]) ${lock ? "FOR UPDATE" : ""}`,
      [...scopeValues(scope), ids],
    );
    result.rows.map(mapCase).forEach((item) => byId.set(normalize(item.caseId), item));
  }
  return caseIds.flatMap((caseId) => {
    const item = byId.get(normalize(caseId));
    return item ? [item] : [];
  });
}

function mapCase(row: DdtCaseRow): DdtCase {
  return {
    id: row.id,
    projectId: row.project_id,
    projectVersionId: row.project_version_id,
    testStageId: row.test_stage_id,
    caseId: row.case_id,
    srNum: row.sr_num,
    kind: row.case_kind,
    data: parseCaseData(row.data_json),
    sourceName: row.source_name,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
  };
}

function mapCaseSummary(row: DdtCaseSummaryRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectVersionId: row.project_version_id,
    testStageId: row.test_stage_id,
    caseId: row.case_id,
    srNum: row.sr_num,
    kind: row.case_kind,
    sourceName: row.source_name,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function mapHistory(row: HistoryRow): DdtCaseHistory {
  return {
    id: row.id,
    ddtCaseId: row.ddt_case_id,
    caseId: row.case_id,
    changeType: row.change_type,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    sourceName: row.source_name,
    before: parseCaseData(row.before_json),
    after: parseCaseData(row.after_json),
    changes: JSON.parse(row.changes_json) as DdtCaseHistory["changes"],
    createdAt: row.created_at,
  };
}

function mapTemplate(row: TemplateRow): DdtCaseTemplate {
  return {
    id: row.id,
    projectId: row.project_id,
    projectVersionId: row.project_version_id,
    testStageId: row.test_stage_id,
    srNum: row.sr_num,
    name: row.name,
    description: row.description,
    rules: JSON.parse(row.rules_json) as DdtTemplateFieldRule[],
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
  };
}

function mapImportFile(row: ImportFileRow): DdtImportFile {
  return {
    id: row.id,
    jobId: row.job_id,
    uploadId: row.upload_id,
    fileName: row.file_name,
    ...(row.archive_entry_name ? { archiveEntryName: row.archive_entry_name } : {}),
    status: row.status,
    rowCount: row.row_count,
    insertedCount: row.inserted_count,
    updatedCount: row.updated_count,
    unchangedCount: row.unchanged_count,
    skippedCount: row.skipped_count,
    ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDeletedSummary(row: DeletedSummaryRow): DdtDeletedCase {
  return {
    id: row.id,
    ddtCaseId: row.ddt_case_id,
    projectId: row.project_id,
    projectVersionId: row.project_version_id,
    testStageId: row.test_stage_id,
    caseId: row.case_id,
    srNum: row.sr_num,
    sourceName: row.source_name,
    deletedAt: row.deleted_at,
    ...(row.deleted_by ? { deletedBy: row.deleted_by } : {}),
  };
}

function templateSelect(): string {
  return `SELECT id, project_id, project_version_id, test_stage_id, sr_num, name,
    description, rules_json, revision, created_by, updated_by, created_at, updated_at
    FROM ddt_case_templates`;
}

function parseCaseData(json: string): DdtCaseData {
  return JSON.parse(json) as DdtCaseData;
}

function parseUploads(json: string): DdtImportJob["uploads"] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? (parsed as DdtImportJob["uploads"]) : [];
}

function scopeValues(scope: DdtScope): [string, string, string] {
  return [scope.projectId, scope.projectVersionId, scope.testStageId];
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function revisionConflict(): never {
  throw new DomainError("DDT_CASE_REVISION_CONFLICT", "DDT 用例已被他人修改，请刷新后重试。");
}

async function transaction<Result>(
  handle: PostgresDatabaseHandle,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await handle.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

class PgWhereBuilder {
  readonly clauses: string[] = [];
  readonly values: PgValue[] = [];

  constructor(scope: DdtScope) {
    this.add("project_id =", scope.projectId);
    this.add("project_version_id =", scope.projectVersionId);
    this.add("test_stage_id =", scope.testStageId);
  }

  get sql(): string {
    return this.clauses.join(" AND ");
  }

  value(value: PgValue): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  add(expression: string, value: PgValue, wrapper = "$n"): void {
    this.clauses.push(`${expression} ${wrapper.replace("$n", this.value(value))}`);
  }

  raw(expression: string): void {
    this.clauses.push(expression);
  }

  addFilter(filter: DdtCaseListQuery["filters"][number]): void {
    const expression =
      filter.field === "CaseID"
        ? "case_id"
        : filter.field === "srNum"
          ? "sr_num"
          : `data_json::jsonb ->> ${this.value(filter.field)}`;
    if (filter.operator === "exists") {
      this.raw(`${expression} IS NOT NULL`);
      return;
    }
    const value = filter.value === null || filter.value === undefined ? "" : String(filter.value);
    const operators = { eq: "=", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
    if (filter.operator in operators) {
      this.raw(
        `${expression} ${operators[filter.operator as keyof typeof operators]} ${this.value(value)}`,
      );
      return;
    }
    this.raw(
      `${expression} LIKE ${this.value(filter.operator === "prefix" ? `${escapeLike(value)}%` : `%${escapeLike(value)}%`)}`,
    );
  }
}
