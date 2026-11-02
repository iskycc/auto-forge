import {
  nodeExporterSourceSchema,
  storageMonitoringTargetSchema,
  updateStorageMonitoringSchema,
  type NodeExporterSource,
  type PostgresStorageCapacity,
  type StorageMonitoringConfiguration,
  type StorageMonitoringTarget,
} from "@autoforge/contracts";
import {
  type AuthenticatedIdentity,
  AuthorizationDeniedError,
  DomainError,
  hasPermission,
} from "@autoforge/domain";
import type { Clock } from "./ports";

export interface StorageMonitoringRepository {
  read(target: StorageMonitoringTarget): Promise<StorageMonitoringConfiguration>;
  save(
    configuration: StorageMonitoringConfiguration,
    updatedAt: string,
  ): Promise<StorageMonitoringConfiguration>;
}

export interface StorageCapacityProbe {
  read(source: NodeExporterSource | null, now: Date): Promise<PostgresStorageCapacity>;
}

export class StorageMonitoringService {
  private pendingProbes = 0;
  constructor(
    private readonly repository: StorageMonitoringRepository,
    private readonly probe: StorageCapacityProbe,
    private readonly clock: Clock,
  ) {}
  read(actor: AuthenticatedIdentity, target: unknown) {
    if (!hasPermission(actor, "settings.read"))
      throw new AuthorizationDeniedError(actor, "settings.read");
    return this.repository.read(storageMonitoringTargetSchema.parse(target));
  }
  save(actor: AuthenticatedIdentity, input: unknown) {
    if (!hasPermission(actor, "settings.manage"))
      throw new AuthorizationDeniedError(actor, "settings.manage");
    return this.repository.save(
      updateStorageMonitoringSchema.parse(input),
      this.clock.now().toISOString(),
    );
  }
  check(actor: AuthenticatedIdentity, source: unknown) {
    if (!hasPermission(actor, "settings.manage"))
      throw new AuthorizationDeniedError(actor, "settings.manage");
    return this.probeSource(nodeExporterSourceSchema.parse(source), this.clock.now());
  }
  private async probeSource(source: NodeExporterSource | null, now: Date) {
    if (this.pendingProbes >= 4)
      throw new DomainError("PLATFORM_LOG_BUSY", "磁盘监控检查繁忙，请稍后重试。");
    this.pendingProbes++;
    try {
      return await this.probe.read(source, now);
    } finally {
      this.pendingProbes--;
    }
  }
  async capacity(target: StorageMonitoringTarget, now: Date): Promise<PostgresStorageCapacity> {
    return this.probeSource((await this.repository.read(target)).source, now);
  }
}
