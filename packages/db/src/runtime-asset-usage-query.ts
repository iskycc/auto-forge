import {
  runtimeAssetUsageQuerySchema,
  type RuntimeAssetUsage,
  type RuntimeAssetUsagePage,
  type RuntimeAssetUsageQuery,
} from "@autoforge/contracts";

type UsageRow = {
  reference_id: string;
  project_id: string;
  project_name: string;
  project_archived: number | boolean;
  project_version_id: string | null;
  project_version_name: string | null;
  version_status: "active" | "archived" | null;
};

/** Query current bindings only; never scan execution snapshots or treat upload ownership as usage. */
export function runtimeAssetUsageQuery(input: RuntimeAssetUsageQuery) {
  const validated = runtimeAssetUsageQuerySchema.parse(input);
  return {
    sql: `WITH usages AS (
      SELECT 'version:' || v.id AS reference_id, p.id AS project_id, p.name AS project_name,
        p.archived AS project_archived, v.id AS project_version_id,
        v.name AS project_version_name, v.status AS version_status
      FROM project_version_runtime_assets r
      JOIN project_versions v ON v.id=r.project_version_id
      JOIN projects p ON p.id=v.project_id
      WHERE r.jdk_asset_id=? OR r.jar_bundle_asset_id=?
      UNION ALL
      SELECT 'project:' || p.id AS reference_id, p.id AS project_id, p.name AS project_name,
        p.archived AS project_archived, NULL AS project_version_id,
        NULL AS project_version_name, NULL AS version_status
      FROM project_adapter_configurations c JOIN projects p ON p.id=c.project_id
      WHERE c.jdk_asset_id=? OR c.jar_bundle_asset_id=?
    ) SELECT * FROM usages WHERE reference_id>? ORDER BY reference_id LIMIT ?`,
    parameters: [
      validated.runtimeAssetId,
      validated.runtimeAssetId,
      validated.runtimeAssetId,
      validated.runtimeAssetId,
      validated.cursor ?? "",
      validated.limit + 1,
    ],
  };
}

export function runtimeAssetUsagePage(rows: UsageRow[], limit: number): RuntimeAssetUsagePage {
  const items: RuntimeAssetUsage[] = rows.slice(0, limit).map((row) => ({
    referenceId: row.reference_id,
    projectId: row.project_id,
    projectName: row.project_name,
    projectArchived: Boolean(row.project_archived),
    ...(row.project_version_id ? { projectVersionId: row.project_version_id } : {}),
    ...(row.project_version_name ? { projectVersionName: row.project_version_name } : {}),
    ...(row.version_status ? { versionStatus: row.version_status } : {}),
  }));
  return { items, ...(rows.length > limit ? { nextCursor: items.at(-1)!.referenceId } : {}) };
}
