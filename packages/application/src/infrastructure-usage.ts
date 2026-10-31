import type { InfrastructureUsageSample } from "@autoforge/contracts";

export type { InfrastructureMetric, InfrastructureUsageSample } from "@autoforge/contracts";

export interface InfrastructureUsagePort {
  readUsage(): Promise<InfrastructureUsageSample>;
}
