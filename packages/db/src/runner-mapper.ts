import type { Runner } from "@autoforge/domain";

type StoredRunner = {
  id: string;
  name: string;
  credentialVersion: number;
  credentialRevokedAt: string | null;
  credentialRotationRequestedAt: string | null;
  deregisteredAt: string | null;
  disabled: boolean;
  draining: boolean;
  os: string;
  architecture: string;
  agentVersion: string;
  protocolVersion: number;
  labelsJson: string;
  capabilitiesJson: string;
  maxConcurrency: number;
  busySlots: number;
  lastSeenAt: string;
  cpuUtilizationPercent: number | null;
  memoryUtilizationPercent: number | null;
  loadAverage1m: number | null;
  logicalCpuCount: number | null;
  metricsObservedAt: string | null;
  terminalEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export function mapStoredRunner(row: StoredRunner, offlineBefore?: string): Runner {
  const labels: unknown = JSON.parse(row.labelsJson);
  const capabilities: unknown = JSON.parse(row.capabilitiesJson);
  return {
    id: row.id,
    name: row.name,
    state: row.disabled
      ? "disabled"
      : row.draining
        ? "draining"
        : offlineBefore && row.lastSeenAt < offlineBefore
          ? "offline"
          : "online",
    os: row.os,
    architecture: row.architecture,
    agentVersion: row.agentVersion,
    protocolVersion: row.protocolVersion,
    labels: Array.isArray(labels)
      ? labels.filter((label): label is string => typeof label === "string")
      : [],
    capabilities: Array.isArray(capabilities)
      ? capabilities.filter((capability): capability is string => typeof capability === "string")
      : [],
    maxConcurrency: row.maxConcurrency,
    busySlots: row.busySlots,
    lastSeenAt: row.lastSeenAt,
    ...(hasCompleteResourceSnapshot(row)
      ? {
          resourceSnapshot: {
            cpuUtilizationPercent: row.cpuUtilizationPercent,
            memoryUtilizationPercent: row.memoryUtilizationPercent,
            loadAverage1m: row.loadAverage1m,
            logicalCpuCount: row.logicalCpuCount,
            observedAt: row.metricsObservedAt,
          },
        }
      : {}),
    terminalEnabled: row.terminalEnabled,
    credentialVersion: row.credentialVersion,
    ...(row.credentialRevokedAt ? { credentialRevokedAt: row.credentialRevokedAt } : {}),
    ...(row.credentialRotationRequestedAt
      ? { credentialRotationRequestedAt: row.credentialRotationRequestedAt }
      : {}),
    ...(row.deregisteredAt ? { deregisteredAt: row.deregisteredAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function hasCompleteResourceSnapshot(row: StoredRunner): row is StoredRunner & {
  cpuUtilizationPercent: number;
  memoryUtilizationPercent: number;
  loadAverage1m: number;
  logicalCpuCount: number;
  metricsObservedAt: string;
} {
  return (
    row.cpuUtilizationPercent !== null &&
    row.memoryUtilizationPercent !== null &&
    row.loadAverage1m !== null &&
    row.logicalCpuCount !== null &&
    row.metricsObservedAt !== null
  );
}
