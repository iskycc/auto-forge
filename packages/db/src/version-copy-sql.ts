import type { VersionCopyRow } from "@autoforge/application";
import type { VersionCopySqlDialect } from "./version-copy-plan";

export const VERSION_COPY_TEMP_KEYS_SQL =
  "CREATE TEMP TABLE IF NOT EXISTS version_copy_keys(ordinal BIGINT PRIMARY KEY,record_key TEXT NOT NULL,copy_row_bytes BIGINT NOT NULL)";

export interface VersionCopyQuery {
  rows(
    sql: string,
    parameters?: readonly (string | number | boolean | null)[],
  ): Promise<VersionCopyRow[]>;
}
export interface VersionCopySql extends VersionCopyQuery {
  dialect: VersionCopySqlDialect;
  transaction<T>(operation: (query: VersionCopyQuery) => Promise<T>): Promise<T>;
  snapshot<T>(operation: (query: VersionCopyQuery) => Promise<T>): Promise<T>;
  columns(query: VersionCopyQuery, table: string): Promise<string[]>;
  close(): Promise<void>;
}
