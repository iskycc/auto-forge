import { sql, type SQL } from "drizzle-orm";
import { DomainError } from "@autoforge/domain";
import {
  caseSuiteMarkersSchema,
  type CaseSuiteMarkerEdit,
  type CaseSuiteMarkerMember,
  type CaseSuiteMemberChange,
  type CaseSuiteMemberKind,
  type CaseSuiteMembershipPage,
} from "@autoforge/contracts";

const memberSources = {
  standard: {
    members: sql`case_suite_items`,
    catalog: sql`case_definitions`,
    caseId: sql`m.case_definition_id`,
    label: sql`c.class_name`,
    markers: sql`case_suite_standard_markers`,
  },
  ddt: {
    members: sql`case_suite_ddt_items`,
    catalog: sql`ddt_cases`,
    caseId: sql`m.ddt_case_id`,
    label: sql`c.case_id`,
    markers: sql`case_suite_ddt_markers`,
  },
} as const;

export type MemberChangeWrite = {
  suiteId: string;
  versionId: string;
  actorId?: string;
  remark?: string;
  updatedAt: string;
};

export function* recordSuiteMemberChange(
  input: MemberChangeWrite,
  kind: CaseSuiteMemberKind,
  operation: CaseSuiteMemberChange["operation"],
  affected: readonly string[],
): Generator<SQL> {
  if (!affected.length) return;
  const actorId = input.actorId ?? null;
  yield sql`INSERT INTO case_suite_member_changes
    (id,suite_id,kind,operation,member_count,actor_id,actor_name,remark,changed_at)
    VALUES (${input.versionId},${input.suiteId},${kind},${operation},${affected.length},
      ${actorId},COALESCE((SELECT username FROM users WHERE id=${actorId}),${actorId}),${input.remark ?? ""},${input.updatedAt})`;
  const source = memberSources[kind];
  for (let start = 0; start < affected.length; start += 200) {
    const values = sql.join(
      affected.slice(start, start + 200).map((id) => sql`(CAST(${id} AS TEXT))`),
      sql`,`,
    );
    yield sql`WITH affected(id) AS (VALUES ${values})
      INSERT INTO case_suite_member_change_items (change_id,case_id,case_label)
      SELECT ${input.versionId}, affected.id, COALESCE(${source.label},affected.id)
      FROM affected LEFT JOIN ${source.catalog} c ON c.id=affected.id`;
  }
}

export function suiteMemberChangesQuery(
  suiteId: string,
  cursor: string | undefined,
  limit: number,
) {
  return sql`SELECT id,kind,operation,member_count AS count,actor_name AS "actorName",remark,changed_at AS "changedAt"
    FROM case_suite_member_changes WHERE suite_id=${suiteId}
    ${cursor ? sql`AND id < ${cursor}` : sql``}
    ORDER BY id DESC LIMIT ${limit + 1}`;
}

export function suiteMemberChangeItemsQuery(
  suiteId: string,
  changeId: string,
  cursor: string | undefined,
  limit: number,
) {
  return sql`SELECT item.case_id AS "caseId",item.case_label AS "caseLabel"
    FROM case_suite_member_change_items item JOIN case_suite_member_changes event ON event.id=item.change_id
    WHERE event.suite_id=${suiteId} AND item.change_id=${changeId}
    ${cursor ? sql`AND item.case_id > ${cursor}` : sql``}
    ORDER BY item.case_id LIMIT ${limit + 1}`;
}

export function membershipPage<T>(
  rows: T[],
  limit: number,
  key: (row: T) => string,
): CaseSuiteMembershipPage<T> {
  const items = rows.slice(0, limit);
  return { items, ...(rows.length > limit ? { nextCursor: key(items.at(-1)!) } : {}) };
}

export type StoredMarkerMember = Omit<CaseSuiteMarkerMember, "markers"> & {
  markersJson: string | null;
};

export function markerMember(row: StoredMarkerMember): CaseSuiteMarkerMember {
  const { markersJson, ...member } = row;
  return {
    ...member,
    markers: markersJson ? caseSuiteMarkersSchema.parse(JSON.parse(markersJson)) : [],
  };
}

export function suiteMarkerMembersQuery(
  suiteId: string,
  kind: CaseSuiteMemberKind,
  cursor: string | undefined,
  limit: number,
  search: string,
) {
  const source = memberSources[kind];
  const pattern = `%${search.toLowerCase().replace(/[!%_]/gu, (char) => `!${char}`)}%`;
  return sql`SELECT m.id AS "memberId",CAST(${kind} AS TEXT) AS kind,${source.label} AS "caseLabel",
      markers.markers_json AS "markersJson"
    FROM ${source.members} m JOIN ${source.catalog} c ON c.id=${source.caseId}
    LEFT JOIN ${source.markers} markers ON markers.member_id=m.id
    WHERE m.suite_id=${suiteId}
    ${cursor ? sql`AND m.id > ${cursor}` : sql``}
    ${search ? sql`AND lower(${source.label}) LIKE ${pattern} ESCAPE '!'` : sql``}
    ORDER BY m.id LIMIT ${limit + 1}`;
}

export function suiteMarkerTargetQuery(
  suiteId: string,
  kind: CaseSuiteMemberKind,
  ids: readonly string[],
) {
  return sql`SELECT id FROM ${memberSources[kind].members} WHERE suite_id=${suiteId}
    AND id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`,`,
    )})`;
}

export function assertSuiteMarkerTargets(expected: readonly CaseSuiteMarkerEdit[], count: number) {
  if (count !== expected.length)
    throw new DomainError(
      "CASE_SUITE_MARKER_MEMBER_MISMATCH",
      "文件包含已移除或不属于此任务的用例成员，请重新导出任务标识。",
    );
}

export function* writeSuiteMarkers(edits: readonly CaseSuiteMarkerEdit[]): Generator<SQL> {
  for (const kind of ["standard", "ddt"] as const) {
    const table = memberSources[kind].markers;
    const kindEdits = edits.filter((edit) => edit.kind === kind);
    const removals = kindEdits.filter((edit) => !edit.markers.some(Boolean));
    if (removals.length)
      yield sql`DELETE FROM ${table} WHERE member_id IN (${sql.join(
        removals.map(({ memberId }) => sql`${memberId}`),
        sql`,`,
      )})`;
    const updates = kindEdits.filter((edit) => edit.markers.some(Boolean));
    if (updates.length)
      yield sql`INSERT INTO ${table}(member_id,markers_json)
        VALUES ${sql.join(
          updates.map(({ memberId, markers }) => sql`(${memberId},${JSON.stringify(markers)})`),
          sql`,`,
        )}
        ON CONFLICT(member_id) DO UPDATE SET markers_json=excluded.markers_json`;
  }
}

export function snapshotSuiteMarkers(batchId: string, suiteId: string) {
  return sql`INSERT INTO execution_run_suite_markers (run_id,batch_id,markers_json)
    SELECT run.id,run.batch_id,stored.markers_json FROM (
      SELECT m.case_definition_id AS case_id,'testng' AS kind,marker.markers_json
      FROM case_suite_items m JOIN case_suite_standard_markers marker ON marker.member_id=m.id
      WHERE m.suite_id=${suiteId}
      UNION ALL
      SELECT m.ddt_case_id,'ddt',marker.markers_json
      FROM case_suite_ddt_items m JOIN case_suite_ddt_markers marker ON marker.member_id=m.id
      WHERE m.suite_id=${suiteId}
    ) stored JOIN execution_runs run ON run.batch_id=${batchId}
      AND run.case_definition_id=stored.case_id AND run.case_type=stored.kind`;
}
