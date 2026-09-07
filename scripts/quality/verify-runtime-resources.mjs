import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const baseline = JSON.parse(await readFile(process.argv[2], "utf8"));
const parallel = JSON.parse(await readFile(process.argv[3], "utf8"));
assert.equal(baseline.resources.cpuCapacity, 1, "Single-core Docker quota was not detected");
assert(parallel.resources.cpuCapacity > 1, "Multi-core container needs at least two CPUs");
assert.equal(baseline.uploadedBytes, parallel.uploadedBytes, "Workloads must be identical");
assert(parallel.plan.logWriteLanes > baseline.plan.logWriteLanes, "Write pool did not scale");
assert(parallel.averageCpuCores > 1.2, "CPU work is still effectively limited to one core");
assert(
  parallel.durationMs < baseline.durationMs * 0.9,
  "Multi-core throughput did not improve by 10%",
);
assert(parallel.p95HttpMs < 1_500, "HTTP responsiveness regressed under CPU load");
process.stdout.write(
  `Container resource acceptance passed: ${parallel.averageCpuCores.toFixed(2)} CPU cores, ${(baseline.durationMs / parallel.durationMs).toFixed(2)}x throughput, HTTP P95 ${parallel.p95HttpMs.toFixed(1)} ms.\n`,
);
