import { postgresStorageSampleSchema, type PostgresStorageCapacity } from "@autoforge/contracts";

type CapacityReader = {
  query(statement: string): Promise<{ rows: Array<{ sample: string | null }> }>;
};

/** PostgreSQL exposes object sizes, not filesystem free space. Read only our collector's fixed file. */
export async function readPostgresStorageCapacity(
  connection: CapacityReader,
  now: Date,
): Promise<PostgresStorageCapacity> {
  try {
    const result = await connection.query(
      "SELECT pg_read_file('autoforge-storage-capacity.json', 0, 4096, true) AS sample",
    );
    const content = result.rows[0]?.sample;
    if (!content)
      return {
        status: "not_configured",
        detail:
          "尚未采集 PostgreSQL 数据目录所在文件系统的余量。请启用部署模板中的磁盘采样；数据库占用量不能推算宿主机剩余空间。",
      };
    const sample = postgresStorageSampleSchema.parse(JSON.parse(content));
    const ageMs = now.getTime() - Date.parse(sample.sampledAt);
    if (ageMs < -60_000)
      return {
        status: "unavailable",
        detail: "PostgreSQL 磁盘采样时间晚于平台时间超过允许偏差，请检查数据库宿主机校时。",
      };
    return {
      status: ageMs > 120_000 ? "stale" : "available",
      detail:
        ageMs > 120_000
          ? "磁盘采样已超过两分钟，以下为历史值，请检查数据库容器的采样健康检查。"
          : "PostgreSQL 数据目录所在文件系统的实际可用空间；非 Web 主机空间，也非日志正文逻辑大小。",
      sampledAt: sample.sampledAt,
      capacityBytes: sample.capacityBytes,
      availableBytes: sample.availableBytes,
      usedPercent: Math.round((1 - sample.availableBytes / sample.capacityBytes) * 10_000) / 100,
    };
  } catch (cause) {
    const denied =
      typeof cause === "object" && cause !== null && "code" in cause && cause.code === "42501";
    return {
      status: denied ? "permission_denied" : "unavailable",
      detail: denied
        ? "当前数据库账号无权读取磁盘采样文件，未自动提升权限。请由数据库管理员配置只读采样访问。"
        : "无法读取有效的 PostgreSQL 磁盘采样，请检查数据目录采样文件、版本与数据库连接。",
    };
  }
}
