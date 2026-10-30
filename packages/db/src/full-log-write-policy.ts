import { DomainError } from "@autoforge/domain";
import type { AttemptLogStore, AsyncAttemptLogStore } from "./attempt-log-store";
import type { ExecutionLogWriteAdmission } from "@autoforge/application";
import type { PostgresDatabaseHandle } from "./postgres-database";

/** Fail before creating a batch; checking availability never opens a payload connection. */
export class PostgresLogWriteAdmission implements ExecutionLogWriteAdmission {
  constructor(private readonly database: PostgresDatabaseHandle) {}
  async requireWriteTarget(): Promise<void> {
    await this.database.ready;
    const selected = await this.database.pool.query<{ storage_mode: string | null }>(
      "SELECT d.storage_mode FROM log_database_settings s LEFT JOIN log_databases d ON d.id=s.active_database_id WHERE s.id=1",
    );
    if (selected.rows[0]?.storage_mode !== "daily")
      throw new DomainError(
        "LOG_DAILY_SERVER_REQUIRED",
        "Full 执行需要独立的按日 PostgreSQL 日志服务器。请先在平台设置 → 日志数据库中添加、检查并设为写入库。",
      );
  }
}

export function fullLocalLogWriteDisabled(): DomainError {
  return new DomainError(
    "FULL_LOCAL_LOG_WRITE_DISABLED",
    "Full 模式禁止写入本地 SQLite 日志。请在平台设置 → 日志数据库中添加并启用 PostgreSQL 日志服务器；历史本地日志仅保留读取。旧本地批次请结束后重新执行。",
  );
}

/** Keep existing file readers and cleanup, but never create or append local logs in Full. */
export function readOnlyLegacyAttemptLogs<T extends AttemptLogStore | AsyncAttemptLogStore>(
  store: T,
): T {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "appendChunks" || property === "recordWatermarks")
        return async () => {
          throw fullLocalLogWriteDisabled();
        };
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
