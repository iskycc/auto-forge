import type { DashboardSnapshotRepository } from "@autoforge/application";
import { dashboardSnapshotSchema, type DashboardSnapshot } from "@autoforge/contracts";

import type { PostgresDatabaseHandle } from "./postgres-database";

type SnapshotRow = { snapshotJson: unknown };
type TargetRow = { projectId: string; projectVersionId: string; timeZone: string };

export class PostgresDashboardSnapshotRepository implements DashboardSnapshotRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async read(input: {
    projectId: string;
    projectVersionId: string;
    timeZone: string;
  }): Promise<DashboardSnapshot | null> {
    await this.handle.ready;
    const result = await this.handle.pool.query<SnapshotRow>(
      `SELECT snapshot_json AS "snapshotJson" FROM dashboard_snapshots
       WHERE project_id=$1 AND project_version_id=$2 AND time_zone=$3`,
      [input.projectId, input.projectVersionId, input.timeZone],
    );
    const parsed = dashboardSnapshotSchema.safeParse(result.rows[0]?.snapshotJson);
    return parsed.success ? parsed.data : null;
  }

  async write(snapshot: DashboardSnapshot): Promise<void> {
    await this.handle.ready;
    const parsed = dashboardSnapshotSchema.parse(snapshot);
    await this.handle.pool.query(
      `INSERT INTO dashboard_snapshots
        (project_id,project_version_id,time_zone,snapshot_json,refreshed_at)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT(project_id,project_version_id) DO UPDATE SET
         time_zone=EXCLUDED.time_zone,
         snapshot_json=EXCLUDED.snapshot_json,
         refreshed_at=EXCLUDED.refreshed_at`,
      [
        parsed.projectId,
        parsed.projectVersionId,
        parsed.timeZone,
        JSON.stringify(parsed),
        parsed.refreshedAt,
      ],
    );
  }

  async listRefreshTargets(limit: number): Promise<TargetRow[]> {
    await this.handle.ready;
    const result = await this.handle.pool.query<TargetRow>(
      `SELECT project_id AS "projectId",project_version_id AS "projectVersionId",
              time_zone AS "timeZone"
       FROM dashboard_snapshots ORDER BY refreshed_at ASC LIMIT $1`,
      [limit],
    );
    return result.rows;
  }
}
