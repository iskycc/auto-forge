import {
  infrastructureUsageSchema,
  type InfrastructureDependency,
  type InfrastructureUsage,
  type InfrastructureUsageSample,
} from "@autoforge/contracts";

export type InfrastructureUsageSource = {
  provider: string;
  read(): Promise<InfrastructureUsageSample>;
};

/** Detail panels are lazy, coalesced and bounded independently of ordinary readiness probes. */
export class InfrastructureUsageReader {
  private readonly cached = new Map<
    InfrastructureDependency,
    { value: InfrastructureUsage; storedAt: number }
  >();
  private readonly pending = new Map<InfrastructureDependency, Promise<InfrastructureUsage>>();
  private readonly probes = new Map<InfrastructureDependency, Promise<InfrastructureUsageSample>>();

  constructor(
    private readonly sources: Record<InfrastructureDependency, InfrastructureUsageSource>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  read(dependency: InfrastructureDependency, refresh = false): Promise<InfrastructureUsage> {
    const pending = this.pending.get(dependency);
    if (pending) return pending;
    const cached = this.cached.get(dependency);
    if (!refresh && cached && performance.now() - cached.storedAt < 15_000)
      return Promise.resolve(cached.value);
    const request = this.collect(dependency)
      .then((value) => {
        this.cached.set(dependency, { value, storedAt: performance.now() });
        return value;
      })
      .finally(() => this.pending.delete(dependency));
    this.pending.set(dependency, request);
    return request;
  }

  private async collect(dependency: InfrastructureDependency): Promise<InfrastructureUsage> {
    const source = this.sources[dependency];
    let probe = this.probes.get(dependency);
    if (!probe) {
      probe = Promise.resolve()
        .then(() => source.read())
        .finally(() => this.probes.delete(dependency));
      this.probes.set(dependency, probe);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const sample = await Promise.race([
        probe,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Usage probe timed out")), 3000);
        }),
      ]);
      return infrastructureUsageSchema.parse({
        dependency,
        provider: source.provider,
        sampledAt: this.now().toISOString(),
        status: sample.storage && sample.storage.status !== "available" ? "partial" : "ready",
        ...sample,
      });
    } catch {
      return {
        dependency,
        provider: source.provider,
        sampledAt: this.now().toISOString(),
        status: "unavailable",
        metrics: [],
        notes: [
          "使用信息暂不可用，请检查中间件状态、统计读取权限或稍后刷新。此状态独立于连接健康检查，不会自动更改平台配置。",
        ],
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
