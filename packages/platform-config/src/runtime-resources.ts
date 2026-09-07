import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { posix } from "node:path";

export type RuntimeResources = { cpuCapacity: number; memoryCapacityBytes: number };
type ResourceProbe = {
  parallelism: number;
  totalMemoryBytes: number;
  constrainedMemoryBytes: number;
  readText(path: string): string | undefined;
};

/** Affinity alone does not describe Docker --cpus. Include ancestor CFS quotas. */
export function detectRuntimeResources(
  probe: ResourceProbe = {
    parallelism: availableParallelism(),
    totalMemoryBytes: totalmem(),
    constrainedMemoryBytes: process.constrainedMemory(),
    readText: readOptionalText,
  },
): RuntimeResources {
  let cpuCapacity = Math.max(1, probe.parallelism);
  for (const location of cpuControllerDirectories(probe.readText)) {
    const quota = location.unified
      ? parseQuota(...(probe.readText(`${location.path}/cpu.max`)?.trim().split(/\s+/) ?? []))
      : parseQuota(
          probe.readText(`${location.path}/cpu.cfs_quota_us`),
          probe.readText(`${location.path}/cpu.cfs_period_us`),
        );
    if (quota !== undefined) cpuCapacity = Math.min(cpuCapacity, quota);
  }
  const constrained = probe.constrainedMemoryBytes;
  return {
    cpuCapacity,
    memoryCapacityBytes:
      constrained > 0 ? Math.min(probe.totalMemoryBytes, constrained) : probe.totalMemoryBytes,
  };
}

function parseQuota(quota?: string, period?: string): number | undefined {
  const numerator = Number(quota);
  const denominator = Number(period);
  return Number.isFinite(numerator) && numerator > 0 && denominator > 0
    ? numerator / denominator
    : undefined;
}

function cpuControllerDirectories(readText: ResourceProbe["readText"]) {
  const memberships = (readText("/proc/self/cgroup") ?? "").split("\n").flatMap((line) => {
    const match = /^\d+:([^:]*):(.*)$/.exec(line);
    return match ? [{ controllers: match[1]!.split(","), path: match[2]! }] : [];
  });
  const directories: Array<{ path: string; unified: boolean }> = [];
  for (const line of (readText("/proc/self/mountinfo") ?? "").split("\n")) {
    const [mount, filesystem] = line.split(" - ");
    if (!mount || !filesystem) continue;
    const [kind, , controllers = ""] = filesystem.split(" ");
    const unified = kind === "cgroup2";
    if (!unified && (kind !== "cgroup" || !controllers.split(",").includes("cpu"))) continue;
    const fields = mount.split(" ");
    const root = unescapeMountPath(fields[3] ?? "");
    const mountPoint = unescapeMountPath(fields[4] ?? "");
    const membership = memberships.find((entry) =>
      entry.controllers.includes(unified ? "" : "cpu"),
    );
    if (!membership || !mountPoint.startsWith("/")) continue;
    // A cgroup namespace can expose its own group as /. Never escape the controller mount.
    const relative = posix.relative(root, membership.path);
    let path = relative.startsWith("..") ? mountPoint : posix.join(mountPoint, relative);
    while (path === mountPoint || path.startsWith(`${mountPoint}/`)) {
      directories.push({ path, unified });
      if (path === mountPoint) break;
      path = posix.dirname(path);
    }
  }
  return directories;
}

function unescapeMountPath(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function readOptionalText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
    )
      return undefined;
    throw new Error(`Cannot inspect runtime resource limit at ${path}.`, { cause: error });
  }
}
