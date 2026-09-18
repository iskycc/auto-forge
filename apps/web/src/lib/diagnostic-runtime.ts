import { hostname } from "node:os";
import { getHeapStatistics } from "node:v8";
import type { RuntimeResources } from "@autoforge/platform-config/runtime-resources";
import type { SystemDiagnostic } from "@autoforge/contracts";

export function readDiagnosticRuntime(
  resources: RuntimeResources,
  deployment: { nodeId?: string; distributed: boolean },
  backgroundAllowed: boolean,
): NonNullable<SystemDiagnostic["runtime"]> {
  const memory = process.memoryUsage();
  return {
    nodeId: deployment.nodeId ?? "local",
    hostname: hostname(),
    distributed: deployment.distributed,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    uptimeSeconds: Math.floor(process.uptime()),
    ...resources,
    availableMemoryBytes: Math.min(resources.memoryCapacityBytes, process.availableMemory()),
    processRssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapLimitBytes: getHeapStatistics().heap_size_limit,
    backgroundAllowed,
  };
}
