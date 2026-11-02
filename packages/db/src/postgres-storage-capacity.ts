import {
  nodeExporterSourceSchema,
  postgresStorageSampleSchema,
  type NodeExporterSource,
  type PostgresStorageCapacity,
} from "@autoforge/contracts";

const MAXIMUM_METRICS_BYTES = 1024 * 1024;
// Leave time for metadata queries inside the enclosing 3-second infrastructure snapshot.
const PROBE_TIMEOUT_MS = 2000;
type Metric = { labels: Map<string, string>; value: number };
/** Read only the configured data-volume mount; never infer capacity from database or Web size. */
export function parseNodeExporterCapacity(
  metrics: string,
  mountpoint: string,
  now: Date,
): PostgresStorageCapacity {
  const families = new Map<string, Metric[]>();
  for (const line of metrics.split("\n")) {
    const match =
      /^(node_filesystem_(?:size_bytes|avail_bytes|device_error)|node_scrape_collector_success)\{([^}]*)\}\s+([^\s]+)(?:\s+\d+)?\s*$/.exec(
        line,
      );
    if (!match) continue;
    const labels = new Map<string, string>();
    for (const label of match[2]!.matchAll(
      /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\[\\"n])*)"(?:,|$)/g,
    )) {
      labels.set(
        label[1]!,
        label[2]!.replace(/\\([\\"n])/g, (_, escaped: string) =>
          escaped === "n" ? "\n" : escaped,
        ),
      );
    }
    if (match[1] === "node_scrape_collector_success") {
      if (labels.get("collector") !== "filesystem") continue;
    } else if (labels.get("mountpoint") !== mountpoint) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) throw new Error("Invalid filesystem metric");
    const samples = families.get(match[1]!) ?? [];
    samples.push({ labels, value });
    families.set(match[1]!, samples);
  }
  const size = families.get("node_filesystem_size_bytes"),
    available = families.get("node_filesystem_avail_bytes"),
    errors = families.get("node_filesystem_device_error"),
    success = families.get("node_scrape_collector_success");
  if (
    success?.length !== 1 ||
    success[0]!.value !== 1 ||
    size?.length !== 1 ||
    available?.length !== 1 ||
    errors?.length !== 1 ||
    errors[0]!.value !== 0
  )
    throw new Error("Missing, ambiguous or failed filesystem collector");
  for (const label of ["device", "fstype"]) {
    const expected = size[0]!.labels.get(label);
    if (
      !expected ||
      available[0]!.labels.get(label) !== expected ||
      errors[0]!.labels.get(label) !== expected
    )
      throw new Error("Mismatched filesystem identity");
  }
  const sample = postgresStorageSampleSchema.parse({
    schemaVersion: 1,
    capacityBytes: size[0]!.value,
    availableBytes: available[0]!.value,
    sampledAt: now.toISOString(),
  });
  return {
    status: "available",
    detail: "通过 Node Exporter 读取配置数据卷的实际余量；容量来自数据库所在数据卷。",
    capacityBytes: sample.capacityBytes,
    availableBytes: sample.availableBytes,
    sampledAt: sample.sampledAt,
    usedPercent: Math.round((1 - sample.availableBytes / sample.capacityBytes) * 10000) / 100,
  };
}

export async function readPostgresStorageCapacity(
  source: NodeExporterSource | null | undefined,
  now: Date,
  request: typeof fetch = fetch,
): Promise<PostgresStorageCapacity> {
  if (!source)
    return {
      status: "not_configured",
      detail:
        "尚未配置 Node Exporter。请启动部署模板中的 monitoring 组件，再填写其地址和数据卷挂载点；无需数据库读文件权限。",
    };
  try {
    const target = nodeExporterSourceSchema.parse(source);
    const host =
      target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host;
    const response = await request(
      `${target.tls ? "https" : "http"}://${host}:${target.port}/metrics?collect%5B%5D=filesystem`,
      {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { accept: "text/plain" },
      },
    );
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return {
        status: "permission_denied",
        detail: "Node Exporter 拒绝访问，请检查监控网络和访问策略。",
      };
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Monitoring endpoint unavailable");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let metrics = "",
      bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAXIMUM_METRICS_BYTES) throw new Error("Monitoring response exceeds limit");
        metrics += decoder.decode(part.value, { stream: true });
      }
      metrics += decoder.decode();
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return parseNodeExporterCapacity(metrics, target.mountpoint, now);
  } catch {
    // Remote errors can contain private endpoints; capacity is observational and must not break execution.
    return {
      status: "unavailable",
      detail:
        "无法读取数据卷指标，请检查 Node Exporter 地址、挂载点、采集器状态或网络；请求最多等待 3 秒。",
    };
  }
}
