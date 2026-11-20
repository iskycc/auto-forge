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
      ${actorId},COALESCE((SELECT username FROM users WHERE id=${actorId}),
        (SELECT name FROM service_accounts WHERE id=${actorId}),${actorId}),${input.remark ?? ""},${input.updatedAt})`;
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

export function* recordSuiteMarkerChanges(
  input: MemberChangeWrite,
  affected: Record<CaseSuiteMemberKind, readonly string[]>,
): Generator<SQL> {
  for (const kind of ["standard", "ddt"] as const)
    yield* recordSuiteMemberChange(
      { ...input, versionId: `${input.versionId}:${kind}` },
      kind,
      "markers",
      affected[kind],
    );
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
  const source = memberSources[kind];
  return sql`SELECT m.id AS "memberId",${source.caseId} AS "caseId",markers.markers_json AS "markersJson"
    FROM ${source.members} m LEFT JOIN ${source.markers} markers ON markers.member_id=m.id
    WHERE m.suite_id=${suiteId} AND m.id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`,`,
    )})`;
}

export type SuiteMarkerTarget = { memberId: string; caseId: string; markersJson: string | null };

export function changedSuiteMarkerTargets(
  edits: readonly CaseSuiteMarkerEdit[],
  targets: readonly SuiteMarkerTarget[],
): (CaseSuiteMarkerEdit & { caseId: string })[] {
  if (targets.length !== edits.length)
    throw new DomainError(
      "CASE_SUITE_MARKER_MEMBER_MISMATCH",
      "文件包含已移除或不属于此任务的用例成员，请重新导出任务标识。",
    );
  const editsById = new Map(edits.map((edit) => [edit.memberId, edit]));
  return targets.flatMap(({ memberId, caseId, markersJson }) => {
    const edit = editsById.get(memberId)!;
    const previous = markersJson ? caseSuiteMarkersSchema.parse(JSON.parse(markersJson)) : [];
    const changed =
      edit.markers.some((marker, index) => marker !== (previous[index] ?? "")) ||
      previous.slice(edit.markers.length).some(Boolean);
    return changed ? [{ ...edit, caseId }] : [];
  });
}

export function* writeSuiteMarkers(
  kind: CaseSuiteMemberKind,
  edits: readonly CaseSuiteMarkerEdit[],
): Generator<SQL> {
  const table = memberSources[kind].markers;
  const removals = edits.filter((edit) => !edit.markers.some(Boolean));
  if (removals.length)
    yield sql`DELETE FROM ${table} WHERE member_id IN (${sql.join(
      removals.map(({ memberId }) => sql`${memberId}`),
      sql`,`,
    )})`;
  const updates = edits.filter((edit) => edit.markers.some(Boolean));
  if (updates.length)
    yield sql`INSERT INTO ${table}(member_id,markers_json)
        VALUES ${sql.join(
          updates.map(({ memberId, markers }) => sql`(${memberId},${JSON.stringify(markers)})`),
          sql`,`,
        )}
        ON CONFLICT(member_id) DO UPDATE SET markers_json=excluded.markers_json`;
}
