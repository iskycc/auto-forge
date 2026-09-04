import type { DashboardSnapshotRepository } from "@autoforge/application";
import { dashboardSnapshotSchema, type DashboardSnapshot } from "@autoforge/contracts";

import { retrySqliteLockContention, type SqliteDatabaseHandle } from "./database";

type SnapshotRow = { snapshotJson: string };
type TargetRow = { projectId: string; projectVersionId: string; timeZone: string };

export class SqliteDashboardSnapshotRepository implements DashboardSnapshotRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async read(input: {
    projectId: string;
    projectVersionId: string;
    timeZone: string;
  }): Promise<DashboardSnapshot | null> {
    const row = this.handle.client
      .prepare(
        `SELECT snapshot_json AS snapshotJson FROM dashboard_snapshots
         WHERE project_id=? AND project_version_id=? AND time_zone=?`,
      )
      .get(input.projectId, input.projectVersionId, input.timeZone) as SnapshotRow | undefined;
    if (!row) return null;
    const parsed = dashboardSnapshotSchema.safeParse(parseJson(row.snapshotJson));
    return parsed.success ? parsed.data : null;
  }

  async write(snapshot: DashboardSnapshot): Promise<void> {
    const parsed = dashboardSnapshotSchema.parse(snapshot);
    await retrySqliteLockContention(() => {
      this.handle.client
        .prepare(
          `INSERT INTO dashboard_snapshots
            (project_id,project_version_id,time_zone,snapshot_json,refreshed_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(project_id,project_version_id) DO UPDATE SET
             time_zone=excluded.time_zone,
             snapshot_json=excluded.snapshot_json,
             refreshed_at=excluded.refreshed_at`,
        )
        .run(
          parsed.projectId,
          parsed.projectVersionId,
          parsed.timeZone,
          JSON.stringify(parsed),
          parsed.refreshedAt,
        );
    });
  }

  async listRefreshTargets(limit: number): Promise<TargetRow[]> {
    return this.handle.client
      .prepare(
        `SELECT project_id AS projectId,project_version_id AS projectVersionId,
                time_zone AS timeZone
         FROM dashboard_snapshots ORDER BY refreshed_at ASC LIMIT ?`,
      )
      .all(limit) as TargetRow[];
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
