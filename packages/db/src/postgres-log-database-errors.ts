import { DomainError, isDomainError } from "@autoforge/domain";

export function logDatabaseError(cause: unknown, id: string): Error {
  if (isDomainError(cause)) return cause;
  return Object.assign(
    new DomainError(
      "PLATFORM_LOG_DATABASE_UNAVAILABLE",
      `日志数据库 ${id} 暂不可用，请检查该库连接、身份及服务状态；日志不会自动改写到其他库。`,
      { cause },
    ),
    {
      runtimeContext: { operation: "log-database.io", database: "attempt-logs", logDatabaseId: id },
    },
  );
}
