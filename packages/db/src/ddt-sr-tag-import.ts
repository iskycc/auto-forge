import { DomainError, normalizeDdtSrTagKey } from "@autoforge/domain";
import type { DdtSrTagScope, SrTagImportRow } from "@autoforge/contracts";
export type SrTagImportPage = Array<SrTagImportRow & { tagId: string }>;
export type SrTagStatement = { sql: string; values: (string | number)[] };
export function srTagImportStatements(
  scope: DdtSrTagScope,
  rows: SrTagImportPage,
  recordedAt: string,
) {
  const uniqueTags = [
    ...new Map(rows.map((row) => [normalizeDdtSrTagKey(row.tagName), row])).values(),
  ];
  return {
    tags: {
      sql: `INSERT INTO ddt_sr_tags(id,project_id,project_version_id,name,normalized_name,created_at) VALUES ${uniqueTags.map(() => "(?,?,?,?,?,?)").join(",")} ON CONFLICT(project_id,project_version_id,normalized_name) DO NOTHING RETURNING id`,
      values: uniqueTags.flatMap((row) => [
        row.tagId,
        scope.projectId,
        scope.projectVersionId,
        row.tagName,
        normalizeDdtSrTagKey(row.tagName),
        recordedAt,
      ]),
    },
    assignments: {
      sql: `WITH input(sr,tag) AS (VALUES ${rows.map(() => "(?,?)").join(",")})
      INSERT INTO ddt_sr_tag_assignments(tag_id,project_id,project_version_id,sr_num_normalized,created_at)
      SELECT t.id,t.project_id,t.project_version_id,i.sr,? FROM input i JOIN ddt_sr_tags t
      ON t.normalized_name=i.tag WHERE t.project_id=? AND t.project_version_id=?
      ON CONFLICT(tag_id,sr_num_normalized) DO NOTHING RETURNING tag_id`,
      values: [
        ...rows.flatMap((row) => [
          normalizeDdtSrTagKey(row.srNum),
          normalizeDdtSrTagKey(row.tagName),
        ]),
        recordedAt,
        scope.projectId,
        scope.projectVersionId,
      ],
    },
  } satisfies Record<string, SrTagStatement>;
}
export function srTagExistingKeysStatement(scope: DdtSrTagScope, srNums: string[]): SrTagStatement {
  return {
    sql: `WITH requested(sr) AS (VALUES ${srNums.map(() => "(?)").join(",")}) SELECT r.sr AS key FROM requested r WHERE EXISTS (SELECT 1 FROM ddt_cases c WHERE c.project_id=? AND c.project_version_id=? AND c.sr_num_normalized=r.sr)`,
    values: [...srNums.map(normalizeDdtSrTagKey), scope.projectId, scope.projectVersionId],
  };
}
export function assertImportSrsExist(rows: SrTagImportPage, existing: Array<{ key: string }>) {
  const keys = new Set(existing.map((row) => row.key));
  const missing = rows.find((row) => !keys.has(normalizeDdtSrTagKey(row.srNum)));
  if (missing)
    throw new DomainError(
      "SR_TAG_IMPORT_SR_NOT_FOUND",
      `${missing.sheetName} 第 ${missing.rowNumber} 行的 SR“${missing.srNum}”已不存在，请重新预览。`,
    );
}
