import {
  nodeExporterSourceSchema,
  type StorageMonitoringConfiguration,
  type StorageMonitoringTarget,
} from "@autoforge/contracts";
import type { StorageMonitoringRepository } from "@autoforge/application";
import { DomainError } from "@autoforge/domain";
import type { PostgresDatabaseHandle } from "./postgres-database";
import { retryPostgresWrite } from "./postgres-transaction";

export class PostgresStorageMonitoringRepository implements StorageMonitoringRepository {
  constructor(private readonly database: PostgresDatabaseHandle) {}
  private async targetId(target: StorageMonitoringTarget) {
    await this.database.ready;
    if (target.kind === "primary") return "primary";
    const row = await this.database.pool.query(
      "SELECT 1 FROM log_databases WHERE id=$1 AND storage_mode IN ('legacy','daily')",
      [target.databaseId],
    );
    if (!row.rowCount) throw new DomainError("LOG_DATABASE_NOT_FOUND", "日志服务器未登记。");
    return `logs:${target.databaseId}`;
  }
  async read(target: StorageMonitoringTarget): Promise<StorageMonitoringConfiguration> {
    const key = await this.targetId(target);
    const result = await this.database.pool.query<{ source_json: string | null; revision: number }>(
      "SELECT source_json,revision FROM storage_monitoring_settings WHERE target_id=$1",
      [key],
    );
    const row = result.rows[0];
    return {
      target,
      source: row?.source_json ? nodeExporterSourceSchema.parse(JSON.parse(row.source_json)) : null,
      revision: row?.revision ?? 1,
    };
  }
  async save(
    configuration: StorageMonitoringConfiguration,
    updatedAt: string,
  ): Promise<StorageMonitoringConfiguration> {
    const key = await this.targetId(configuration.target);
    const result = await retryPostgresWrite(() =>
      this.database.pool.query<{ revision: number }>(
        `INSERT INTO storage_monitoring_settings(target_id,source_json,revision,updated_at)
       SELECT $1,$2,2,$3 WHERE $4=1 OR EXISTS(SELECT 1 FROM storage_monitoring_settings WHERE target_id=$1)
       ON CONFLICT(target_id) DO UPDATE SET source_json=excluded.source_json,revision=storage_monitoring_settings.revision+1,updated_at=excluded.updated_at
       WHERE storage_monitoring_settings.revision=$4 RETURNING revision`,
        [
          key,
          configuration.source ? JSON.stringify(configuration.source) : null,
          updatedAt,
          configuration.revision,
        ],
      ),
    );
    if (!result.rows[0])
      throw new DomainError("REVISION_CONFLICT", "磁盘监控配置已被修改，请关闭后重新打开。");
    return { ...configuration, revision: result.rows[0].revision };
  }
}
