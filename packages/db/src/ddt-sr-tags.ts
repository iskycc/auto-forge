import type { DdtSrTagRepository } from "@autoforge/application";
import type { DdtSrTagScope, DdtSrTagQuery, DdtSrTag, DdtSrTagFilter } from "@autoforge/contracts";
import { srTagExistingKeysStatement, type SrTagImportPage } from "./ddt-sr-tag-import";
import { DomainError, normalizeDdtSrTagKey as normalized } from "@autoforge/domain";

type Value = string | number;
export type SrTagSql = <T extends Record<string, unknown>>(
  sql: string,
  values: Value[],
) => Promise<T[]>;
export type SrTagWriteSql = <T extends Record<string, unknown>>(
  scope: DdtSrTagScope,
  sql: string,
  values: Value[],
) => Promise<T[]>;
const scopeValues = (scope: DdtSrTagScope) => [scope.projectId, scope.projectVersionId];
const marks = (values: unknown[]) => values.map(() => "?").join(",");

/** Queries use only indexed metadata and bounded windows; case JSON never enters this path. */
export class SqlDdtSrTagRepository implements DdtSrTagRepository {
  constructor(
    private readonly sql: SrTagSql,
    private readonly dialect: "sqlite" | "postgres",
    private readonly write: SrTagWriteSql,
    readonly importPage: (
      scope: DdtSrTagScope,
      rows: SrTagImportPage,
      recordedAt: string,
    ) => Promise<number>,
  ) {}
  async findSrKeys(scope: DdtSrTagScope, srNums: string[]) {
    if (!srNums.length) return [];
    const statement = srTagExistingKeysStatement(scope, srNums);
    return (await this.sql<{ key: string }>(statement.sql, statement.values)).map((row) => row.key);
  }
  async classifications(scope: DdtSrTagScope, cursor?: string) {
    let after = { sr: "", tag: "" };
    if (cursor) {
      try {
        const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !("sr" in parsed) ||
          !("tag" in parsed) ||
          typeof parsed.sr !== "string" ||
          typeof parsed.tag !== "string"
        )
          throw new Error("invalid cursor");
        after = { sr: parsed.sr, tag: parsed.tag };
      } catch (cause) {
        throw new DomainError("SR_TAG_EXPORT_CURSOR_INVALID", "标签导出游标无效。", {
          cause: cause instanceof Error ? cause.message : "invalid cursor",
        });
      }
    }
    const rows = await this.sql<{ srNum: string; tagName: string; sr: string; tag: string }>(
      `SELECT
      COALESCE((SELECT min(c.sr_num) FROM ddt_cases c WHERE c.project_id=a.project_id AND c.project_version_id=a.project_version_id AND c.sr_num_normalized=a.sr_num_normalized),a.sr_num_normalized) AS "srNum",
      t.name AS "tagName",a.sr_num_normalized AS sr,a.tag_id AS tag FROM ddt_sr_tag_assignments a JOIN ddt_sr_tags t ON t.id=a.tag_id
      WHERE a.project_id=? AND a.project_version_id=? AND (a.sr_num_normalized>? OR (a.sr_num_normalized=? AND a.tag_id>?))
      ORDER BY a.sr_num_normalized,a.tag_id LIMIT 201`,
      [...scopeValues(scope), after.sr, after.sr, after.tag],
    );
    const last = rows[199];
    return {
      items: rows.slice(0, 200).map(({ srNum, tagName }) => ({ srNum, tagName })),
      ...(rows.length > 200 && last
        ? {
            nextCursor: Buffer.from(JSON.stringify({ sr: last.sr, tag: last.tag })).toString(
              "base64url",
            ),
          }
        : {}),
    };
  }
  private contains(column: string) {
    return this.dialect === "sqlite" ? `instr(${column}, ?) > 0` : `strpos(${column}, ?) > 0`;
  }
  async list(scope: DdtSrTagScope, query: DdtSrTagQuery) {
    const rows = await this.sql<{ id: string; name: string; cursor: string }>(
      `SELECT id,name,normalized_name AS cursor FROM ddt_sr_tags
       WHERE project_id=? AND project_version_id=? AND normalized_name>?
       AND ${this.contains("normalized_name")} ${query.tagIds ? `AND id IN (${marks(query.tagIds)})` : ""} ORDER BY normalized_name LIMIT ?`,
      [
        ...scopeValues(scope),
        query.cursor ?? "",
        normalized(query.query),
        ...(query.tagIds ?? []),
        query.limit + 1,
      ],
    );
    return page(rows, query.limit, (row) => ({ id: row.id, name: row.name }));
  }
  async create(scope: DdtSrTagScope, tag: DdtSrTag, recordedAt: string) {
    const rows = await this.write<{ id: string; name: string }>(
      scope,
      `INSERT INTO ddt_sr_tags(id,project_id,project_version_id,name,normalized_name,created_at)
       SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM project_versions WHERE id=? AND project_id=?)
       ON CONFLICT(project_id,project_version_id,normalized_name) DO UPDATE SET normalized_name=excluded.normalized_name
       RETURNING id,name`,
      [
        tag.id,
        ...scopeValues(scope),
        tag.name,
        normalized(tag.name),
        recordedAt,
        scope.projectVersionId,
        scope.projectId,
      ],
    );
    if (!rows[0]) throw new DomainError("DDT_SCOPE_NOT_FOUND", "项目版本不存在。");
    return rows[0];
  }
  async assign(
    scope: DdtSrTagScope,
    input: { tagId: string; srNum: string; assigned: boolean },
    recordedAt: string,
  ) {
    const sr = normalized(input.srNum);
    if (!input.assigned) {
      await this.write(
        scope,
        `DELETE FROM ddt_sr_tag_assignments WHERE tag_id=? AND project_id=? AND project_version_id=? AND sr_num_normalized=? RETURNING tag_id`,
        [input.tagId, ...scopeValues(scope), sr],
      );
      return;
    }
    const rows = await this.write(
      scope,
      `INSERT INTO ddt_sr_tag_assignments(tag_id,project_id,project_version_id,sr_num_normalized,created_at)
       SELECT id,project_id,project_version_id,?,? FROM ddt_sr_tags
       WHERE id=? AND project_id=? AND project_version_id=?
       AND EXISTS (SELECT 1 FROM ddt_cases WHERE project_id=? AND project_version_id=? AND sr_num_normalized=?)
       ON CONFLICT(tag_id,sr_num_normalized) DO UPDATE SET sr_num_normalized=excluded.sr_num_normalized RETURNING tag_id`,
      [sr, recordedAt, input.tagId, ...scopeValues(scope), ...scopeValues(scope), sr],
    );
    if (!rows.length)
      throw new DomainError(
        "DDT_SR_TAG_NOT_FOUND",
        "标签或 SR 不存在于当前项目版本，请刷新后重试。",
      );
  }
  async lookup(scope: DdtSrTagScope, srNums: string[]) {
    if (!srNums.length) return {};
    const rows = await this.sql<{ sr: string; id: string; name: string }>(
      `SELECT a.sr_num_normalized AS sr,t.id,t.name FROM ddt_sr_tag_assignments a
       JOIN ddt_sr_tags t ON t.id=a.tag_id WHERE a.project_id=? AND a.project_version_id=?
       AND a.sr_num_normalized IN (${marks(srNums)}) ORDER BY a.sr_num_normalized,t.normalized_name LIMIT 3201`,
      [...scopeValues(scope), ...srNums.map(normalized)],
    );
    if (rows.length > 3200)
      throw new DomainError("DDT_SR_TAG_LIMIT", "SR 标签数量过多，请减少每个 SR 的标签数量。");
    const result: Record<string, DdtSrTag[]> = Object.create(null) as Record<string, DdtSrTag[]>;
    for (const sr of srNums)
      result[sr] = rows
        .filter((row) => row.sr === normalized(sr))
        .map(({ id, name }) => ({ id, name }));
    return result;
  }
  async groups(scope: DdtSrTagScope, query: DdtSrTagQuery) {
    const rows = await this.sql<{ srNum: string; caseCount: number; cursor: string }>(
      `SELECT min(sr_num) AS "srNum",count(*) AS "caseCount",sr_num_normalized AS cursor FROM ddt_cases
       WHERE project_id=? AND project_version_id=? AND sr_num_normalized>? AND ${this.contains("sr_num_normalized")}
       GROUP BY sr_num_normalized ORDER BY sr_num_normalized LIMIT ?`,
      [...scopeValues(scope), query.cursor ?? "", normalized(query.query), query.limit + 1],
    );
    const items = rows.slice(0, query.limit);
    const tags = await this.lookup(
      scope,
      items.map((row) => row.srNum),
    );
    return page(rows, query.limit, (row) => ({
      srNum: row.srNum,
      caseCount: Number(row.caseCount),
      tags: tags[row.srNum] ?? [],
    }));
  }
  async members(scope: DdtSrTagScope, suiteId: string, filter: DdtSrTagFilter) {
    // Validate every tag: an obsolete/foreign tag must never select the entire complement by mistake.
    const tags = await this.sql<{ id: string }>(
      `SELECT id FROM ddt_sr_tags WHERE project_id=? AND project_version_id=? AND id IN (${marks(filter.tagIds)})`,
      [...scopeValues(scope), ...filter.tagIds],
    );
    if (tags.length !== new Set(filter.tagIds).size)
      throw new DomainError("DDT_SR_TAG_NOT_FOUND", "所选标签已不存在于当前版本，请重新选择。");
    // Bound candidates before filtering: a rare tag must not scan an entire large task in one request.
    const rows = await this.sql<{
      id: string | null;
      srNum: string | null;
      cursor: string;
      matched: number;
    }>(
      `WITH member_window AS MATERIALIZED (
         SELECT id,ddt_case_id FROM case_suite_ddt_items WHERE suite_id=? AND id>? ORDER BY id LIMIT 201
       ) SELECT c.id,c.sr_num AS "srNum",m.id AS cursor,
       CASE WHEN c.id IS NOT NULL AND ${filter.match === "exclude" ? "NOT" : ""} EXISTS (
         SELECT 1 FROM ddt_sr_tag_assignments a WHERE a.project_id=c.project_id
         AND a.project_version_id=c.project_version_id AND a.sr_num_normalized=c.sr_num_normalized
         AND a.tag_id IN (${marks(filter.tagIds)})) THEN 1 ELSE 0 END AS matched
       FROM member_window m LEFT JOIN ddt_cases c ON c.id=m.ddt_case_id
         AND c.project_id=? AND c.project_version_id=? ORDER BY m.id`,
      [suiteId, filter.cursor ?? "", ...filter.tagIds, ...scopeValues(scope)],
    );
    const window = page(rows, 200, (row) => row);
    return {
      ...window,
      items: window.items.flatMap((row) =>
        row.matched && row.id !== null && row.srNum !== null
          ? [{ id: row.id, srNum: row.srNum }]
          : [],
      ),
    };
  }
}
function page<T extends { cursor: string }, R>(rows: T[], limit: number, map: (row: T) => R) {
  return {
    items: rows.slice(0, limit).map(map),
    ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.cursor } : {}),
  };
}
