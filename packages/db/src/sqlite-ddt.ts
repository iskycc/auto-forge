import {
  DomainError,
  ddtCaseCell,
  diffDdtCaseData,
  isDdtJourney,
  type DdtCase,
  type DdtCaseData,
  type DdtCaseHistory,
  type DdtCaseTemplate,
  type DdtExecutionClass,
  type DdtScope,
  type DdtTemplateFieldRule,
} from "@autoforge/domain";
import type {
  DdtCaseListQuery,
  DdtDeletedCase,
  DdtImportFile,
  DdtImportJob,
  DdtRepository,
} from "@autoforge/application";

import { batchesOf, RELATIONAL_ID_QUERY_BATCH_SIZE } from "./database-batches";
import { runSqliteWriteTransaction, type SqliteDatabaseHandle } from "./database";

type SqlValue = string | number | null;

const executionClassColumns = `execution_case_definition_id AS executionCaseDefinitionId,
  (SELECT class_name FROM case_definitions WHERE id = execution_case_definition_id) AS executionClassName,
  (SELECT display_name FROM case_definitions WHERE id = execution_case_definition_id) AS executionDisplayName,
  (SELECT source_id FROM case_definitions WHERE id = execution_case_definition_id) AS executionSourceId,
  (SELECT current_version FROM case_definitions WHERE id = execution_case_definition_id) AS executionCurrentVersion,
  (SELECT enabled FROM case_definitions WHERE id = execution_case_definition_id) AS executionEnabled,
  (SELECT archived FROM case_definitions WHERE id = execution_case_definition_id) AS executionArchived`;

export class SqliteDdtRepository implements DdtRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async listCases(query: DdtCaseListQuery) {
    const where = scopeSql(query);
    const parameters: SqlValue[] = scopeParameters(query);
    if (query.cursor) {
      where.push("case_id_normalized > ?");
      parameters.push(query.cursor);
    }
    if (query.query) {
      where.push("case_id_normalized LIKE ? ESCAPE '\\'");
      parameters.push(`${escapeLike(normalize(query.query))}%`);
    }
    if (query.srNum) {
      where.push("sr_num_normalized = ?");
      parameters.push(normalize(query.srNum));
    }
    if (query.sourceName) {
      where.push("source_name LIKE ? ESCAPE '\\'");
      parameters.push(`%${escapeLike(query.sourceName)}%`);
    }
    for (const filter of query.filters) appendSqliteFilter(where, parameters, filter);
    const rows = this.handle.client
      .prepare(
        `SELECT id, project_id AS projectId, project_version_id AS projectVersionId,
                test_stage_id AS testStageId, case_id AS caseId,
                case_id_normalized AS caseIdNormalized, sr_num AS srNum,
                case_kind AS kind, source_name AS sourceName, revision, updated_at AS updatedAt,
                ${executionClassColumns}
         FROM ddt_cases
         WHERE ${where.join(" AND ")}
         ORDER BY case_id_normalized, id
         LIMIT ?`,
      )
      .all(...parameters, query.limit + 1) as DdtCaseSummaryRow[];
    const items = rows.slice(0, query.limit).map((row) => ({
      id: row.id,
      projectId: row.projectId,
      projectVersionId: row.projectVersionId,
      testStageId: row.testStageId,
      caseId: row.caseId,
      srNum: row.srNum,
      kind: row.kind,
      sourceName: row.sourceName,
      revision: row.revision,
      updatedAt: row.updatedAt,
      ...mapExecutionClass(row),
    }));
    const next = rows.length > query.limit ? rows[query.limit - 1]?.caseIdNormalized : undefined;
    return { items, ...(next ? { nextCursor: next } : {}) };
  }

  async getCase(scope: DdtScope, caseId: string): Promise<DdtCase | null> {
    const row = this.handle.client
      .prepare(
        `SELECT id, project_id AS projectId, project_version_id AS projectVersionId,
                test_stage_id AS testStageId, case_id AS caseId, sr_num AS srNum,
                case_kind AS kind, data_json AS dataJson, source_name AS sourceName,
                revision, created_at AS createdAt, updated_at AS updatedAt, updated_by AS updatedBy,
                ${executionClassColumns}
         FROM ddt_cases
         WHERE project_id = ? AND project_version_id = ? AND test_stage_id = ?
           AND case_id_normalized = ?
         LIMIT 1`,
      )
      .get(...scopeParameters(scope), normalize(caseId)) as DdtCaseRow | undefined;
    return row ? mapCase(row) : null;
  }

  async getCases(scope: DdtScope, caseIds: readonly string[]): Promise<DdtCase[]> {
    if (caseIds.length === 0) return [];
    const byId = new Map<string, DdtCase>();
    for (const ids of batchesOf(caseIds.map(normalize), RELATIONAL_ID_QUERY_BATCH_SIZE)) {
      const placeholders = ids.map(() => "?").join(",");
      const rows = this.handle.client
        .prepare(
          `SELECT id, project_id AS projectId, project_version_id AS projectVersionId,
                  test_stage_id AS testStageId, case_id AS caseId, sr_num AS srNum,
                  case_kind AS kind, data_json AS dataJson, source_name AS sourceName,
                  revision, created_at AS createdAt, updated_at AS updatedAt, updated_by AS updatedBy,
                  ${executionClassColumns}
           FROM ddt_cases
           WHERE project_id = ? AND project_version_id = ? AND test_stage_id = ?
             AND case_id_normalized IN (${placeholders})`,
        )
        .all(...scopeParameters(scope), ...ids) as DdtCaseRow[];
      rows.map(mapCase).forEach((item) => byId.set(normalize(item.caseId), item));
    }
    return caseIds.flatMap((caseId) => {
      const item = byId.get(normalize(caseId));
      return item ? [item] : [];
    });
  }

  async findCaseData(
    scope: DdtScope,
    caseIds: readonly string[],
  ): Promise<Map<string, DdtCaseData>> {
    return new Map(
      (await this.getCases(scope, [...new Set(caseIds.map(normalize))])).map((item) => [
        normalize(item.caseId),
        item.data,
      ]),
    );
  }

  async listExecutionClasses(
    scope: DdtScope,
    query = "",
    limit = 50,
  ): Promise<DdtExecutionClass[]> {
    const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
    const pattern = `%${escapeLike(normalizedQuery)}%`;
    return this.handle.client
      .prepare(
        `SELECT definition.id AS caseDefinitionId, definition.class_name AS className,
                definition.display_name AS displayName, definition.source_id AS sourceId,
                definition.current_version AS currentVersion, definition.enabled,
                definition.archived
         FROM case_definitions definition
         JOIN case_sources source ON source.id = definition.source_id
         WHERE definition.project_id = ? AND definition.project_version_id = ?
           AND definition.test_stage_id = ? AND source.authoritative = 1
           AND source.status = 'ready' AND source.lifecycle_status = 'active'
           AND (? = '' OR lower(definition.class_name) LIKE ? ESCAPE '\\'
                        OR lower(definition.display_name) LIKE ? ESCAPE '\\')
         ORDER BY definition.class_name, definition.id LIMIT ?`,
      )
      .all(
        ...scopeParameters(scope),
        normalizedQuery,
        pattern,
        pattern,
        Math.min(Math.max(limit, 1), 100),
      ) as DdtExecutionClass[];
  }

  async findExecutionClass(scope: DdtScope, className: string): Promise<DdtExecutionClass | null> {
    return (
      (this.handle.client
        .prepare(
          `SELECT definition.id AS caseDefinitionId, definition.class_name AS className,
                  definition.display_name AS displayName, definition.source_id AS sourceId,
                  definition.current_version AS currentVersion, definition.enabled,
                  definition.archived
           FROM case_definitions definition
           JOIN case_sources source ON source.id = definition.source_id
           WHERE definition.project_id = ? AND definition.project_version_id = ?
             AND definition.test_stage_id = ? AND definition.class_name = ?
             AND source.authoritative = 1 AND source.status = 'ready'
             AND source.lifecycle_status = 'active' LIMIT 1`,
        )
        .get(...scopeParameters(scope), className.trim()) as DdtExecutionClass | undefined) ?? null
    );
  }

  async setExecutionClass(
    input: Parameters<DdtRepository["setExecutionClass"]>[0],
  ): Promise<number> {
    let updated = 0;
    runSqliteWriteTransaction(this.handle, () => {
      for (const caseIds of batchesOf(
        input.caseIds.map(normalize),
        RELATIONAL_ID_QUERY_BATCH_SIZE,
      )) {
        const placeholders = caseIds.map(() => "?").join(",");
        updated += this.handle.client
          .prepare(
            `UPDATE ddt_cases
             SET execution_case_definition_id = ?, revision = revision + 1,
                 updated_by = ?, updated_at = ?
             WHERE project_id = ? AND project_version_id = ? AND test_stage_id = ?
               AND case_id_normalized IN (${placeholders})`,
          )
          .run(
            input.executionCaseDefinitionId,
            input.actorId ?? null,
            input.updatedAt,
            ...scopeParameters(input.scope),
            ...caseIds,
          ).changes;
      }
    });
    return updated;
  }

  async listGroups(scope: DdtScope, query = "", limit = 100) {
    const where = scopeSql(scope);
    const parameters: SqlValue[] = scopeParameters(scope);
    if (query.trim()) {
      where.push("sr_num_normalized LIKE ? ESCAPE '\\'");
      parameters.push(`${escapeLike(normalize(query))}%`);
    }
    return this.handle.client
      .prepare(
        `SELECT MIN(sr_num) AS srNum, COUNT(*) AS count
         FROM ddt_cases WHERE ${where.join(" AND ")}
         GROUP BY sr_num_normalized ORDER BY count DESC, sr_num_normalized LIMIT ?`,
      )
      .all(...parameters, Math.min(Math.max(limit, 1), 500)) as Array<{
      srNum: string;
      count: number;
    }>;
  }

  async dashboard(scope: DdtScope) {
    const parameters = scopeParameters(scope);
    const counts = this.handle.client
      .prepare(
        `SELECT COUNT(*) AS caseCount,
                COUNT(DISTINCT sr_num_normalized) AS groupCount,
                SUM(CASE WHEN case_kind = 'journey' THEN 1 ELSE 0 END) AS journeyCount,
                SUM(CASE WHEN substr(created_at, 1, 10) = substr(?, 1, 10) THEN 1 ELSE 0 END) AS importedToday,
                SUM(CASE WHEN substr(updated_at, 1, 10) = substr(?, 1, 10)
                          AND updated_at != created_at THEN 1 ELSE 0 END) AS updatedToday
         FROM ddt_cases
         WHERE project_id = ? AND project_version_id = ? AND test_stage_id = ?`,
      )
      .get(new Date().toISOString(), new Date().toISOString(), ...parameters) as {
      caseCount: number;
      groupCount: number;
      journeyCount: number | null;
      importedToday: number | null;
      updatedToday: number | null;
    };
    const sourceCount = (
      this.handle.client
        .prepare(
          `SELECT COUNT(*) AS value FROM ddt_import_files f
           JOIN ddt_import_jobs j ON j.id = f.job_id
           WHERE j.project_id = ? AND j.project_version_id = ? AND j.test_stage_id = ?
             AND f.status = 'succeeded'`,
        )
        .get(...parameters) as { value: number }
    ).value;
    const groups = await this.listGroups(scope, "", 8);
    const timeline = this.handle.client
      .prepare(
        `SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count
         FROM ddt_cases
         WHERE project_id = ? AND project_version_id = ? AND test_stage_id = ?
           AND created_at >= ?
         GROUP BY substr(created_at, 1, 10) ORDER BY date`,
      )
      .all(...parameters, new Date(Date.now() - 6 * 86_400_000).toISOString()) as Array<{
      date: string;
      count: number;
    }>;
    return {
      caseCount: counts.caseCount,
      groupCount: counts.groupCount,
      sourceCount,
      journeyCount: counts.journeyCount ?? 0,
      importedToday: counts.importedToday ?? 0,
      updatedToday: counts.updatedToday ?? 0,
      groups,
      timeline,
    };
  }

  async exportCases(selection: DdtScope & { caseIds?: string[]; srNum?: string }) {
    const where = scopeSql(selection);
    const parameters: SqlValue[] = scopeParameters(selection);
    if (selection.srNum) {
      where.push("sr_num_normalized = ?");
      parameters.push(normalize(selection.srNum));
    }
    if (selection.caseIds?.length) {
      where.push(`case_id_normalized IN (${selection.caseIds.map(() => "?").join(",")})`);
      parameters.push(...selection.caseIds.map(normalize));
    }
    const rows = this.handle.client
      .prepare(
        `SELECT data_json AS dataJson FROM ddt_cases
         WHERE ${where.join(" AND ")} ORDER BY case_id_normalized`,
      )
      .all(...parameters) as Array<{ dataJson: string }>;
    return rows.map((row) => parseCaseData(row.dataJson));
  }

  async updateCases(records: Parameters<DdtRepository["updateCases"]>[0]): Promise<DdtCase[]> {
    if (records.length === 0) return [];
    runSqliteWriteTransaction(this.handle, () => {
      for (const record of records) {
        const current = this.handle.client
          .prepare(
            `SELECT id, case_id AS caseId, data_json AS dataJson, revision
             FROM ddt_cases
             WHERE project_id = ? AND project_version_id = ? AND test_stage_id = ?
               AND case_id_normalized = ? LIMIT 1`,
          )
          .get(...scopeParameters(record.scope), normalize(record.caseId)) as
          { id: string; caseId: string; dataJson: string; revision: number } | undefined;
        if (!current) throw new DomainError("DDT_CASE_NOT_FOUND", "指定的 DDT 用例不存在。");
        if (current.revision !== record.expectedRevision) {
          throw new DomainError(
            "DDT_CASE_REVISION_CONFLICT",
            "DDT 用例已被他人修改，请刷新后重试。",
          );
        }
        const before = parseCaseData(current.dataJson);
        const nextCaseId = String(ddtCaseCell(record.nextData, "CaseID"));
        const nextSrNum = String(ddtCaseCell(record.nextData, "srNum"));
        const duplicate = this.handle.client
          .prepare(
            `SELECT 1 FROM ddt_cases
             WHERE project_id = ? AND project_version_id = ? AND test_stage_id = ?
               AND case_id_normalized = ? AND id <> ? LIMIT 1`,
          )
          .get(...scopeParameters(record.scope), normalize(nextCaseId), current.id);
        if (duplicate) {
          throw new DomainError(
            "DDT_CASE_ID_CONFLICT",
            `CaseID“${nextCaseId}”已存在，请使用其他标识。`,
          );
        }
        const result = this.handle.client
          .prepare(
            `UPDATE ddt_cases
             SET case_id = ?, case_id_normalized = ?, sr_num = ?, sr_num_normalized = ?,
                 case_kind = ?, data_json = ?, revision = revision + 1,
                 updated_by = ?, updated_at = ?
             WHERE id = ? AND revision = ?`,
          )
          .run(
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
          );
        if (result.changes !== 1) {
          throw new DomainError(
            "DDT_CASE_REVISION_CONFLICT",
            "DDT 用例已被他人修改，请刷新后重试。",
          );
        }
        this.handle.client
          .prepare(
            `INSERT INTO ddt_case_history
             (id, ddt_case_id, case_id, change_type, actor_id, source_name,
              before_json, after_json, changes_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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
          );
      }
    });
    return this.getCases(
      records[0]!.scope,
      records.map((record) => String(ddtCaseCell(record.nextData, "CaseID"))),
    );
  }

  async trashCases(input: Parameters<DdtRepository["trashCases"]>[0]): Promise<number> {
    return runSqliteWriteTransaction(this.handle, () => {
      const cases = this.getCasesSync(input.scope, input.caseIds);
      if (cases.length !== input.caseIds.length) {
        throw new DomainError("DDT_CASE_NOT_FOUND", "删除选择中包含不存在的 DDT 用例。");
      }
      assertDdtCasesAreNotSuiteMembers(this.handle, cases);
      for (const [index, item] of cases.entries()) {
        this.handle.client
          .prepare(
            `INSERT INTO ddt_deleted_cases
             (id, ddt_case_id, project_id, project_version_id, test_stage_id,
              case_id, case_id_normalized, sr_num, sr_num_normalized, case_kind,
              data_json, source_file_id, execution_case_definition_id, source_name,
              case_created_at, case_updated_at,
              deleted_by, deleted_at)
             SELECT ?, id, project_id, project_version_id, test_stage_id,
                    case_id, case_id_normalized, sr_num, sr_num_normalized, case_kind,
                    data_json, source_file_id, execution_case_definition_id, source_name,
                    created_at, updated_at, ?, ?
             FROM ddt_cases WHERE id = ?`,
          )
          .run(input.recycleIds[index], input.actorId ?? null, input.deletedAt, item.id);
        this.handle.client.prepare("DELETE FROM ddt_cases WHERE id = ?").run(item.id);
      }
      return cases.length;
    });
  }

  async listDeletedCases(input: DdtScope & { query?: string; cursor?: string; limit: number }) {
    const where = scopeSql(input);
    const parameters: SqlValue[] = scopeParameters(input);
    if (input.query) {
      where.push("(case_id_normalized LIKE ? ESCAPE '\\' OR sr_num_normalized LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(normalize(input.query))}%`;
      parameters.push(pattern, pattern);
    }
    if (input.cursor) {
      where.push("id < ?");
      parameters.push(input.cursor);
    }
    const rows = this.handle.client
      .prepare(
        `SELECT id, ddt_case_id AS ddtCaseId, project_id AS projectId,
                project_version_id AS projectVersionId, test_stage_id AS testStageId,
                case_id AS caseId, sr_num AS srNum, source_name AS sourceName,
                deleted_at AS deletedAt, deleted_by AS deletedBy
         FROM ddt_deleted_cases WHERE ${where.join(" AND ")}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...parameters, input.limit + 1) as DdtDeletedCase[];
    const items = rows.slice(0, input.limit);
    const next = rows.length > input.limit ? items.at(-1)?.id : undefined;
    return { items, ...(next ? { nextCursor: next } : {}) };
  }

  async restoreDeletedCase(input: Parameters<DdtRepository["restoreDeletedCase"]>[0]) {
    let caseId = "";
    runSqliteWriteTransaction(this.handle, () => {
      const row = this.handle.client
        .prepare(
          `SELECT * FROM ddt_deleted_cases
           WHERE id = ? AND project_id = ? AND project_version_id = ? AND test_stage_id = ?`,
        )
        .get(input.recycleId, ...scopeParameters(input.scope)) as DeletedCaseRow | undefined;
      if (!row) throw new DomainError("DDT_RECYCLE_NOT_FOUND", "回收站记录不存在。");
      caseId = row.case_id;
      const duplicate = this.handle.client
        .prepare(
          `SELECT 1 FROM ddt_cases WHERE project_id = ? AND project_version_id = ?
           AND test_stage_id = ? AND case_id_normalized = ? LIMIT 1`,
        )
        .get(...scopeParameters(input.scope), row.case_id_normalized);
      if (duplicate)
        throw new DomainError("DDT_CASE_ID_CONFLICT", `CaseID“${row.case_id}”已存在，无法恢复。`);
      this.handle.client
        .prepare(
          `INSERT INTO ddt_cases
           (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized,
            sr_num, sr_num_normalized, case_kind, data_json, source_file_id,
            execution_case_definition_id, source_name,
            revision, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
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
          row.execution_case_definition_id,
          row.source_name,
          input.actorId ?? null,
          input.actorId ?? null,
          row.case_created_at,
          input.restoredAt,
        );
      this.handle.client.prepare("DELETE FROM ddt_deleted_cases WHERE id = ?").run(input.recycleId);
    });
    const restored = await this.getCase(input.scope, caseId);
    if (!restored) throw new Error("Restored DDT case was not found.");
    return restored;
  }

  async purgeDeletedCase(scope: DdtScope, recycleId: string): Promise<boolean> {
    return (
      this.handle.client
        .prepare(
          `DELETE FROM ddt_deleted_cases
           WHERE id = ? AND project_id = ? AND project_version_id = ? AND test_stage_id = ?`,
        )
        .run(recycleId, ...scopeParameters(scope)).changes > 0
    );
  }

  async listHistory(input: DdtScope & { caseId: string; cursor?: string; limit: number }) {
    const item = await this.getCase(input, input.caseId);
    if (!item) return { items: [] };
    const rows = this.handle.client
      .prepare(
        `SELECT id, ddt_case_id AS ddtCaseId, case_id AS caseId, change_type AS changeType,
                actor_id AS actorId, source_name AS sourceName, before_json AS beforeJson,
                after_json AS afterJson, changes_json AS changesJson, created_at AS createdAt
         FROM ddt_case_history
         WHERE ddt_case_id = ? ${input.cursor ? "AND id < ?" : ""}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(item.id, ...(input.cursor ? [input.cursor] : []), input.limit + 1) as HistoryRow[];
    const mapped = rows.slice(0, input.limit).map(mapHistory);
    const next = rows.length > input.limit ? mapped.at(-1)?.id : undefined;
    return { items: mapped, ...(next ? { nextCursor: next } : {}) };
  }

  async getHistory(scope: DdtScope, caseId: string, historyId: string) {
    const item = await this.getCase(scope, caseId);
    if (!item) return null;
    const row = this.handle.client
      .prepare(
        `SELECT id, ddt_case_id AS ddtCaseId, case_id AS caseId, change_type AS changeType,
                actor_id AS actorId, source_name AS sourceName, before_json AS beforeJson,
                after_json AS afterJson, changes_json AS changesJson, created_at AS createdAt
         FROM ddt_case_history WHERE id = ? AND ddt_case_id = ? LIMIT 1`,
      )
      .get(historyId, item.id) as HistoryRow | undefined;
    return row ? mapHistory(row) : null;
  }

  async listTemplates(scope: DdtScope): Promise<DdtCaseTemplate[]> {
    const rows = this.handle.client
      .prepare(
        `SELECT id, project_id AS projectId, project_version_id AS projectVersionId,
                test_stage_id AS testStageId, sr_num AS srNum, name, description,
                rules_json AS rulesJson, revision, created_by AS createdBy,
                updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt
         FROM ddt_case_templates
         WHERE project_id = ? AND project_version_id = ? AND test_stage_id = ?
         ORDER BY sr_num_normalized`,
      )
      .all(...scopeParameters(scope)) as TemplateRow[];
    return rows.map(mapTemplate);
  }

  async getTemplateForSrNum(scope: DdtScope, srNum: string) {
    const row = this.handle.client
      .prepare(
        `SELECT id, project_id AS projectId, project_version_id AS projectVersionId,
                test_stage_id AS testStageId, sr_num AS srNum, name, description,
                rules_json AS rulesJson, revision, created_by AS createdBy,
                updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt
         FROM ddt_case_templates
         WHERE project_id = ? AND project_version_id = ? AND test_stage_id = ?
           AND sr_num_normalized = ? LIMIT 1`,
      )
      .get(...scopeParameters(scope), normalize(srNum)) as TemplateRow | undefined;
    return row ? mapTemplate(row) : null;
  }

  async writeTemplate(record: Parameters<DdtRepository["writeTemplate"]>[0]) {
    runSqliteWriteTransaction(this.handle, () => {
      if (record.expectedRevision !== undefined) {
        const result = this.handle.client
          .prepare(
            `UPDATE ddt_case_templates
             SET sr_num = ?, sr_num_normalized = ?, name = ?, description = ?, rules_json = ?,
                 revision = revision + 1, updated_by = ?, updated_at = ?
             WHERE id = ? AND project_id = ? AND project_version_id = ? AND test_stage_id = ?
               AND revision = ?`,
          )
          .run(
            record.srNum,
            normalize(record.srNum),
            record.name,
            record.description,
            JSON.stringify(record.rules),
            record.actorId ?? null,
            record.now,
            record.id,
            ...scopeParameters(record),
            record.expectedRevision,
          );
        if (result.changes !== 1) {
          throw new DomainError(
            "DDT_TEMPLATE_REVISION_CONFLICT",
            "字段模板已被他人修改，请刷新后重试。",
          );
        }
      } else {
        this.handle.client
          .prepare(
            `INSERT INTO ddt_case_templates
             (id, project_id, project_version_id, test_stage_id, sr_num, sr_num_normalized,
              name, description, rules_json, revision, created_by, updated_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          )
          .run(
            record.id,
            ...scopeParameters(record),
            record.srNum,
            normalize(record.srNum),
            record.name,
            record.description,
            JSON.stringify(record.rules),
            record.actorId ?? null,
            record.actorId ?? null,
            record.now,
            record.now,
          );
      }
    });
    const item = (await this.listTemplates(record)).find((template) => template.id === record.id);
    if (!item) throw new Error("DDT template was not persisted.");
    return item;
  }

  async deleteTemplate(scope: DdtScope, templateId: string, expectedRevision: number) {
    return (
      this.handle.client
        .prepare(
          `DELETE FROM ddt_case_templates
           WHERE id = ? AND project_id = ? AND project_version_id = ? AND test_stage_id = ?
             AND revision = ?`,
        )
        .run(templateId, ...scopeParameters(scope), expectedRevision).changes > 0
    );
  }

  async createImportPreview(input: Parameters<DdtRepository["createImportPreview"]>[0]) {
    runSqliteWriteTransaction(this.handle, () => {
      const job = input.job;
      this.handle.client
        .prepare(
          `INSERT INTO ddt_import_jobs
           (id, project_id, project_version_id, test_stage_id, status, uploads_json,
            progress_percent, total_files, valid_files, total_rows, inserted_count,
            updated_count, unchanged_count, skipped_count, failed_files, requested_by,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.id,
          ...scopeParameters(job),
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
        );
      const insertFile = this.handle.client.prepare(
        `INSERT INTO ddt_import_files
         (id, job_id, upload_id, file_name, archive_entry_name, status, row_count,
          inserted_count, updated_count, unchanged_count, skipped_count, error_summary,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      );
      for (const file of input.files) {
        insertFile.run(
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
        );
      }
    });
    const job = await this.getImportJob(input.job.id);
    if (!job) throw new Error("DDT import preview was not persisted.");
    return job;
  }

  async replaceImportPreview(input: Parameters<DdtRepository["replaceImportPreview"]>[0]) {
    runSqliteWriteTransaction(this.handle, () => {
      if (input.projectIds?.length === 0) {
        throw new DomainError("DDT_IMPORT_NOT_FOUND", "导入任务不存在。");
      }
      const scope = input.projectIds
        ? `AND project_id IN (${input.projectIds.map(() => "?").join(",")})`
        : "";
      const updated = this.handle.client
        .prepare(
          `UPDATE ddt_import_jobs
           SET uploads_json = ?, progress_percent = 0, total_files = ?, valid_files = ?,
               total_rows = ?, inserted_count = 0, updated_count = 0, unchanged_count = 0,
               skipped_count = 0, failed_files = ?, error_code = NULL, error_summary = NULL,
               updated_at = ?
           WHERE id = ? AND status = 'previewed' ${scope}`,
        )
        .run(
          JSON.stringify(input.uploads),
          input.totalFiles,
          input.validFiles,
          input.totalRows,
          input.failedFiles,
          input.updatedAt,
          input.jobId,
          ...(input.projectIds ?? []),
        );
      if (updated.changes !== 1) {
        throw new DomainError(
          "DDT_IMPORT_STATE_CONFLICT",
          "导入预检不存在或已启动，无法更新列名处理结果。",
        );
      }
      this.handle.client.prepare("DELETE FROM ddt_import_files WHERE job_id = ?").run(input.jobId);
      const insertFile = this.handle.client.prepare(
        `INSERT INTO ddt_import_files
         (id, job_id, upload_id, file_name, archive_entry_name, status, row_count,
          inserted_count, updated_count, unchanged_count, skipped_count, error_summary,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      );
      for (const file of input.files) {
        insertFile.run(
          file.id,
          input.jobId,
          file.uploadId,
          file.fileName,
          file.archiveEntryName ?? null,
          file.errorSummary ? "excluded" : "valid",
          file.rowCount,
          file.insertedCount,
          file.updatedCount,
          file.unchangedCount,
          file.errorSummary ?? null,
          input.updatedAt,
          input.updatedAt,
        );
      }
    });
    const job = await this.getImportJob(input.jobId, input.projectIds);
    if (!job) throw new Error("DDT import preview replacement was not persisted.");
    return job;
  }

  async confirmImport(input: Parameters<DdtRepository["confirmImport"]>[0]) {
    runSqliteWriteTransaction(this.handle, () => {
      const scope = input.projectIds
        ? `AND project_id IN (${input.projectIds.map(() => "?").join(",")})`
        : "";
      if (input.projectIds?.length === 0)
        throw new DomainError("DDT_IMPORT_NOT_FOUND", "导入任务不存在。");
      const result = this.handle.client
        .prepare(
          `UPDATE ddt_import_jobs SET status = 'queued', conflict_strategy = ?, updated_at = ?
           WHERE id = ? AND status = 'previewed' AND valid_files > 0 ${scope}`,
        )
        .run(input.conflictStrategy, input.updatedAt, input.jobId, ...(input.projectIds ?? []));
      if (result.changes !== 1) {
        throw new DomainError(
          "DDT_IMPORT_STATE_CONFLICT",
          "导入预检不存在、没有有效表格或已启动。",
        );
      }
      this.handle.client
        .prepare(
          `INSERT INTO queue_jobs
           (message_id, run_id, attempt, schema_version, kind, payload_json, priority,
            deduplication_key, status, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
        )
        .run(
          input.dispatchJob.messageId,
          input.dispatchJob.runId,
          input.dispatchJob.attempt,
          input.dispatchJob.schemaVersion,
          input.dispatchJob.kind,
          JSON.stringify(input.dispatchJob.payload),
          input.dispatchJob.priority,
          input.dispatchJob.deduplicationKey,
          input.dispatchJob.createdAt,
          input.dispatchJob.createdAt,
          input.dispatchJob.createdAt,
        );
    });
    const job = await this.getImportJob(input.jobId, input.projectIds);
    if (!job) throw new Error("Confirmed DDT import job was not found.");
    return job;
  }

  async getImportJob(jobId: string, projectIds?: readonly string[]) {
    if (projectIds?.length === 0) return null;
    const scope = projectIds ? `AND project_id IN (${projectIds.map(() => "?").join(",")})` : "";
    const row = this.handle.client
      .prepare(`SELECT * FROM ddt_import_jobs WHERE id = ? ${scope} LIMIT 1`)
      .get(jobId, ...(projectIds ?? [])) as ImportJobRow | undefined;
    return row ? this.mapImportJob(row) : null;
  }

  async listImportJobs(input: DdtScope & { cursor?: string; limit: number }) {
    const rows = this.handle.client
      .prepare(
        `SELECT * FROM ddt_import_jobs
         WHERE project_id = ? AND project_version_id = ? AND test_stage_id = ?
           ${input.cursor ? "AND id < ?" : ""}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(
        ...scopeParameters(input),
        ...(input.cursor ? [input.cursor] : []),
        input.limit + 1,
      ) as ImportJobRow[];
    const items = await Promise.all(
      rows.slice(0, input.limit).map((row) => this.mapImportJob(row)),
    );
    const next = rows.length > input.limit ? items.at(-1)?.id : undefined;
    return { items, ...(next ? { nextCursor: next } : {}) };
  }

  async claimImportJob(jobId: string, startedAt: string) {
    const result = this.handle.client
      .prepare(
        `UPDATE ddt_import_jobs
         SET status = 'running', progress_percent = 1, started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(startedAt, startedAt, jobId);
    return result.changes === 1 ? this.getImportJob(jobId) : null;
  }

  async requestImportCancellation(
    jobId: string,
    updatedAt: string,
    projectIds?: readonly string[],
  ) {
    if (projectIds?.length === 0) throw new DomainError("DDT_IMPORT_NOT_FOUND", "导入任务不存在。");
    const scope = projectIds ? `AND project_id IN (${projectIds.map(() => "?").join(",")})` : "";
    const result = this.handle.client
      .prepare(
        `UPDATE ddt_import_jobs
         SET status = CASE WHEN status IN ('previewed', 'queued') THEN 'cancelled'
                           ELSE 'cancel_requested' END,
             progress_percent = CASE WHEN status IN ('previewed', 'queued') THEN 100 ELSE progress_percent END,
             finished_at = CASE WHEN status IN ('previewed', 'queued') THEN ? ELSE finished_at END,
             updated_at = ?
         WHERE id = ? AND status IN ('previewed', 'queued', 'running') ${scope}`,
      )
      .run(updatedAt, updatedAt, jobId, ...(projectIds ?? []));
    if (result.changes !== 1)
      throw new DomainError("DDT_IMPORT_STATE_CONFLICT", "导入任务无法取消。");
    const job = await this.getImportJob(jobId, projectIds);
    if (!job) throw new Error("Cancelled DDT import job was not found.");
    return job;
  }

  async updateImportJob(input: Parameters<DdtRepository["updateImportJob"]>[0]) {
    const current = await this.getImportJob(input.jobId);
    if (!current) throw new Error(`DDT import job ${input.jobId} does not exist.`);
    this.handle.client
      .prepare(
        `UPDATE ddt_import_jobs
         SET status = ?, progress_percent = ?, inserted_count = ?, updated_count = ?,
             unchanged_count = ?, skipped_count = ?, failed_files = ?, error_code = ?,
             error_summary = ?, updated_at = ?, finished_at = ? WHERE id = ?`,
      )
      .run(
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
      );
    const job = await this.getImportJob(input.jobId);
    if (!job) throw new Error("Updated DDT import job was not found.");
    return job;
  }

  async updateImportFile(input: Parameters<DdtRepository["updateImportFile"]>[0]) {
    this.handle.client
      .prepare(
        `UPDATE ddt_import_files
         SET status = ?, inserted_count = COALESCE(?, inserted_count),
             updated_count = COALESCE(?, updated_count),
             unchanged_count = COALESCE(?, unchanged_count),
             skipped_count = COALESCE(?, skipped_count), error_summary = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.result?.insertedCount ?? null,
        input.result?.updatedCount ?? null,
        input.result?.unchangedCount ?? null,
        input.result?.skippedCount ?? null,
        input.errorSummary ?? null,
        input.updatedAt,
        input.fileId,
      );
  }

  async importFile(input: Parameters<DdtRepository["importFile"]>[0]) {
    return runSqliteWriteTransaction(this.handle, () => {
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
        const existing = this.handle.client
          .prepare(
            `SELECT id, data_json AS dataJson FROM ddt_cases
             WHERE project_id = ? AND project_version_id = ? AND test_stage_id = ?
               AND case_id_normalized = ? LIMIT 1`,
          )
          .get(...scopeParameters(input.scope), normalizedCaseId) as
          { id: string; dataJson: string } | undefined;
        let outcome: "inserted" | "updated" | "unchanged" | "skipped";
        if (!existing) {
          this.handle.client
            .prepare(
              `INSERT INTO ddt_cases
               (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized,
                sr_num, sr_num_normalized, case_kind, data_json, source_file_id, source_name,
                revision, created_by, updated_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
            )
            .run(
              row.id,
              ...scopeParameters(input.scope),
              row.caseId,
              normalizedCaseId,
              row.srNum,
              normalize(row.srNum),
              isDdtJourney(row.data) ? "journey" : "standard",
              JSON.stringify(row.data),
              input.fileId,
              input.sourceName,
              input.actorId ?? null,
              input.actorId ?? null,
              input.importedAt,
              input.importedAt,
            );
          result.insertedCount += 1;
          outcome = "inserted";
        } else {
          const before = parseCaseData(existing.dataJson);
          if (JSON.stringify(before) === JSON.stringify(row.data)) {
            result.unchangedCount += 1;
            outcome = "unchanged";
          } else if (input.conflictStrategy === "skip") {
            result.skippedCount += 1;
            outcome = "skipped";
          } else if (input.conflictStrategy === "error") {
            throw new DomainError("DDT_IMPORT_CONFLICT", `CaseID“${row.caseId}”已存在。`);
          } else {
            this.handle.client
              .prepare(
                `UPDATE ddt_cases
                 SET case_id = ?, sr_num = ?, sr_num_normalized = ?, case_kind = ?, data_json = ?,
                     source_file_id = ?, source_name = ?, revision = revision + 1,
                     updated_by = ?, updated_at = ? WHERE id = ?`,
              )
              .run(
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
              );
            this.handle.client
              .prepare(
                `INSERT INTO ddt_case_history
                 (id, ddt_case_id, case_id, change_type, actor_id, source_name,
                  before_json, after_json, changes_json, created_at)
                 VALUES (?, ?, ?, 'import_overwrite', ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                input.historyIds[index],
                existing.id,
                row.caseId,
                input.actorId ?? null,
                input.sourceName,
                JSON.stringify(before),
                JSON.stringify(row.data),
                JSON.stringify(diffDdtCaseData(before, row.data)),
                input.importedAt,
              );
            result.updatedCount += 1;
            outcome = "updated";
          }
        }
        result.caseIds.push({ caseId: row.caseId, outcome });
        this.handle.client
          .prepare(
            `INSERT INTO ddt_import_case_ids(job_id, case_id, case_id_normalized, outcome, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(job_id, case_id_normalized) DO UPDATE SET
               case_id = excluded.case_id, outcome = excluded.outcome`,
          )
          .run(input.jobId, row.caseId, normalizedCaseId, outcome, input.importedAt);
      }
      this.handle.client
        .prepare(
          `UPDATE ddt_import_files
           SET status = 'succeeded', inserted_count = ?, updated_count = ?,
               unchanged_count = ?, skipped_count = ?, error_summary = NULL, updated_at = ?
           WHERE id = ? AND job_id = ?`,
        )
        .run(
          result.insertedCount,
          result.updatedCount,
          result.unchangedCount,
          result.skippedCount,
          input.importedAt,
          input.fileId,
          input.jobId,
        );
      return result;
    });
  }

  async listImportCaseIds(jobId: string, projectIds?: readonly string[]) {
    const job = await this.getImportJob(jobId, projectIds);
    if (!job) throw new DomainError("DDT_IMPORT_NOT_FOUND", "导入任务不存在。");
    return this.handle.client
      .prepare(
        `SELECT case_id AS caseId, outcome FROM ddt_import_case_ids
         WHERE job_id = ? ORDER BY case_id_normalized`,
      )
      .all(jobId) as Array<{
      caseId: string;
      outcome: "inserted" | "updated" | "unchanged" | "skipped";
    }>;
  }

  private getCasesSync(scope: DdtScope, caseIds: readonly string[]): DdtCase[] {
    if (caseIds.length === 0) return [];
    const byId = new Map<string, DdtCase>();
    for (const ids of batchesOf(caseIds.map(normalize), RELATIONAL_ID_QUERY_BATCH_SIZE)) {
      const rows = this.handle.client
        .prepare(
          `SELECT id, project_id AS projectId, project_version_id AS projectVersionId,
                  test_stage_id AS testStageId, case_id AS caseId, sr_num AS srNum,
                  case_kind AS kind, data_json AS dataJson, source_name AS sourceName,
                  revision, created_at AS createdAt, updated_at AS updatedAt, updated_by AS updatedBy
           FROM ddt_cases WHERE project_id = ? AND project_version_id = ? AND test_stage_id = ?
             AND case_id_normalized IN (${ids.map(() => "?").join(",")})`,
        )
        .all(...scopeParameters(scope), ...ids) as DdtCaseRow[];
      rows.map(mapCase).forEach((item) => byId.set(normalize(item.caseId), item));
    }
    return caseIds.flatMap((caseId) => {
      const item = byId.get(normalize(caseId));
      return item ? [item] : [];
    });
  }

  private async mapImportJob(row: ImportJobRow): Promise<DdtImportJob> {
    const fileRows = this.handle.client
      .prepare(
        `SELECT id, job_id AS jobId, upload_id AS uploadId, file_name AS fileName,
                archive_entry_name AS archiveEntryName, status, row_count AS rowCount,
                inserted_count AS insertedCount, updated_count AS updatedCount,
                unchanged_count AS unchangedCount, skipped_count AS skippedCount,
                error_summary AS errorSummary, created_at AS createdAt, updated_at AS updatedAt
         FROM ddt_import_files WHERE job_id = ? ORDER BY created_at, id`,
      )
      .all(row.id) as ImportFileRow[];
    return {
      id: row.id,
      projectId: row.project_id,
      projectVersionId: row.project_version_id,
      testStageId: row.test_stage_id,
      status: row.status,
      ...(row.conflict_strategy ? { conflictStrategy: row.conflict_strategy } : {}),
      uploads: parseUploads(row.uploads_json),
      files: fileRows.map(mapImportFile),
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
  projectId: string;
  projectVersionId: string;
  testStageId: string;
  caseId: string;
  srNum: string;
  kind: "standard" | "journey";
  dataJson: string;
  sourceName: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  executionCaseDefinitionId: string | null;
  executionClassName: string | null;
  executionDisplayName: string | null;
  executionSourceId: string | null;
  executionCurrentVersion: number | null;
  executionEnabled: number | null;
  executionArchived: number | null;
};

type DdtCaseSummaryRow = Omit<DdtCaseRow, "dataJson" | "createdAt" | "updatedBy"> & {
  caseIdNormalized: string;
};

type HistoryRow = {
  id: string;
  ddtCaseId: string;
  caseId: string;
  changeType: DdtCaseHistory["changeType"];
  actorId: string | null;
  sourceName: string;
  beforeJson: string;
  afterJson: string;
  changesJson: string;
  createdAt: string;
};

type TemplateRow = Omit<DdtCaseTemplate, "rules"> & { rulesJson: string };

type ImportFileRow = Omit<DdtImportFile, "archiveEntryName" | "errorSummary"> & {
  archiveEntryName: string | null;
  errorSummary: string | null;
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
  execution_case_definition_id: string | null;
  source_name: string;
  case_created_at: string;
  case_updated_at: string;
};

function mapCase(row: DdtCaseRow): DdtCase {
  return {
    id: row.id,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    testStageId: row.testStageId,
    caseId: row.caseId,
    srNum: row.srNum,
    kind: row.kind,
    data: parseCaseData(row.dataJson),
    sourceName: row.sourceName,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
    ...mapExecutionClass(row),
  };
}

function mapExecutionClass(
  row: Pick<
    DdtCaseRow,
    | "executionCaseDefinitionId"
    | "executionClassName"
    | "executionDisplayName"
    | "executionSourceId"
    | "executionCurrentVersion"
    | "executionEnabled"
    | "executionArchived"
  >,
): Pick<DdtCase, "executionClass"> {
  if (
    !row.executionCaseDefinitionId ||
    !row.executionClassName ||
    !row.executionDisplayName ||
    !row.executionSourceId ||
    row.executionCurrentVersion === null ||
    row.executionEnabled === null ||
    row.executionArchived === null
  ) {
    return {};
  }
  return {
    executionClass: {
      caseDefinitionId: row.executionCaseDefinitionId,
      className: row.executionClassName,
      displayName: row.executionDisplayName,
      sourceId: row.executionSourceId,
      currentVersion: row.executionCurrentVersion,
      enabled: row.executionEnabled === 1,
      archived: row.executionArchived === 1,
    },
  };
}

function assertDdtCasesAreNotSuiteMembers(
  handle: SqliteDatabaseHandle,
  cases: readonly DdtCase[],
): void {
  const caseById = new Map(cases.map((item) => [item.id, item]));
  for (const ids of batchesOf([...caseById.keys()], RELATIONAL_ID_QUERY_BATCH_SIZE)) {
    const placeholders = ids.map(() => "?").join(",");
    const member = handle.client
      .prepare(
        `SELECT ddt_case_id AS ddtCaseId FROM case_suite_ddt_items
         WHERE ddt_case_id IN (${placeholders}) LIMIT 1`,
      )
      .get(...ids) as { ddtCaseId: string } | undefined;
    if (member) {
      const ddtCase = caseById.get(member.ddtCaseId);
      throw new DomainError(
        "DDT_CASE_IN_USE",
        `DDT 用例“${ddtCase?.caseId ?? member.ddtCaseId}”仍在用例任务中，请先从任务移除。`,
      );
    }
  }
}

function mapHistory(row: HistoryRow): DdtCaseHistory {
  return {
    id: row.id,
    ddtCaseId: row.ddtCaseId,
    caseId: row.caseId,
    changeType: row.changeType,
    ...(row.actorId ? { actorId: row.actorId } : {}),
    sourceName: row.sourceName,
    before: parseCaseData(row.beforeJson),
    after: parseCaseData(row.afterJson),
    changes: JSON.parse(row.changesJson) as DdtCaseHistory["changes"],
    createdAt: row.createdAt,
  };
}

function mapTemplate(row: TemplateRow): DdtCaseTemplate {
  const { rulesJson, ...template } = row;
  return { ...template, rules: JSON.parse(rulesJson) as DdtTemplateFieldRule[] };
}

function mapImportFile(row: ImportFileRow): DdtImportFile {
  return {
    id: row.id,
    jobId: row.jobId,
    uploadId: row.uploadId,
    fileName: row.fileName,
    ...(row.archiveEntryName ? { archiveEntryName: row.archiveEntryName } : {}),
    status: row.status,
    rowCount: row.rowCount,
    insertedCount: row.insertedCount,
    updatedCount: row.updatedCount,
    unchangedCount: row.unchangedCount,
    skippedCount: row.skippedCount,
    ...(row.errorSummary ? { errorSummary: row.errorSummary } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseCaseData(json: string): DdtCaseData {
  return JSON.parse(json) as DdtCaseData;
}

function parseUploads(json: string): DdtImportJob["uploads"] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? (parsed as DdtImportJob["uploads"]) : [];
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function scopeSql(scope: DdtScope): string[] {
  void scope;
  return ["project_id = ?", "project_version_id = ?", "test_stage_id = ?"];
}

function scopeParameters(scope: DdtScope): [string, string, string] {
  return [scope.projectId, scope.projectVersionId, scope.testStageId];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function appendSqliteFilter(
  where: string[],
  parameters: SqlValue[],
  filter: DdtCaseListQuery["filters"][number],
): void {
  const path = `$[${JSON.stringify(filter.field)}]`;
  const expression =
    filter.field === "CaseID"
      ? "case_id"
      : filter.field === "srNum"
        ? "sr_num"
        : "json_extract(data_json, ?)";
  if (expression.startsWith("json")) parameters.push(path);
  if (filter.operator === "exists") {
    where.push(`${expression} IS NOT NULL`);
    return;
  }
  const value = filter.value === null || filter.value === undefined ? "" : String(filter.value);
  const operators = { eq: "=", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
  if (filter.operator in operators) {
    where.push(`${expression} ${operators[filter.operator as keyof typeof operators]} ?`);
    parameters.push(value);
    return;
  }
  where.push(`${expression} LIKE ? ESCAPE '\\'`);
  parameters.push(
    filter.operator === "prefix" ? `${escapeLike(value)}%` : `%${escapeLike(value)}%`,
  );
}
