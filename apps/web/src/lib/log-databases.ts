import { DomainError } from "@autoforge/domain";
import { getPlatformServices } from "./services";

export async function requireLogDatabases() {
  const services = await getPlatformServices();
  if (!services.logDatabases)
    throw new DomainError(
      "LOG_DATABASE_UNSUPPORTED",
      "独立 PostgreSQL 日志数据库仅在 Full 部署中可用。",
    );
  return { services, logDatabases: services.logDatabases };
}
