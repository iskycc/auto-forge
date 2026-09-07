import { describe, expect, it } from "vitest";
import { detectRuntimeResources } from "../src/runtime-resources";

function probe(files: Record<string, string>, constrainedMemoryBytes = 0) {
  return detectRuntimeResources({
    parallelism: 32,
    totalMemoryBytes: 32 * 1024 ** 3,
    constrainedMemoryBytes,
    readText: (path) => files[path],
  });
}

describe("container resource discovery", () => {
  it("uses the tightest cgroup v2 ancestor quota and the process memory limit", () => {
    const resources = probe(
      {
        "/proc/self/cgroup": "0::/team/web",
        "/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
        "/sys/fs/cgroup/team/web/cpu.max": "800000 100000",
        "/sys/fs/cgroup/team/cpu.max": "250000 100000",
      },
      4 * 1024 ** 3,
    );
    expect(resources).toEqual({ cpuCapacity: 2.5, memoryCapacityBytes: 4 * 1024 ** 3 });
  });

  it("respects v1 quotas and cpuset affinity without inventing a one-core limit", () => {
    expect(
      probe({
        "/proc/self/cgroup": "3:cpu,cpuacct:/docker/web",
        "/proc/self/mountinfo":
          "1 0 0:1 /docker/web /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu,cpuacct",
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "400000",
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
      }).cpuCapacity,
    ).toBe(4);
    expect(probe({}).cpuCapacity).toBe(32);
  });

  it("handles unlimited, fractional and unavailable resource limits", () => {
    const files = {
      "/proc/self/cgroup": "0::/",
      "/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
      "/sys/fs/cgroup/cpu.max": "max 100000",
    };
    expect(probe(files, Number.MAX_VALUE).memoryCapacityBytes).toBe(32 * 1024 ** 3);
    expect(probe(files).cpuCapacity).toBe(32);
    files["/sys/fs/cgroup/cpu.max"] = "50000 100000";
    expect(probe(files).cpuCapacity).toBe(0.5);
  });
});
