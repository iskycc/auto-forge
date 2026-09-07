import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { detectRuntimeResources } from "@autoforge/platform-config/runtime-resources";
import { LogIoPool } from "../../apps/web/server/log-io-pool";
import { webResourcePlan } from "../../apps/web/src/lib/worker-sizing";

// This fixture is bundled into a temporary acceptance image, never a release asset.
if (process.argv[2] === "configure") {
  const store = new PlatformConfigurationStore(process.argv[3]!);
  const configuration = store.initialize();
  store.replace(
    {
      ...configuration,
      web: {
        ...configuration.web,
        hostname: "0.0.0.0",
        port: 3100,
        publicBaseUrl: "http://127.0.0.1:3100",
      },
      scheduler: { ...configuration.scheduler, projectMaximumConcurrency: 500 },
      limits: { ...configuration.limits, authLoginAttemptsPerWindow: 500 },
    },
    configuration.revision,
  );
} else await measureLogs();

async function measureLogs(): Promise<void> {
  const resources = detectRuntimeResources();
  const plan = webResourcePlan(resources, "full", 10);
  const directory = await mkdtemp(join(tmpdir(), "autoforge-cpu-probe-"));
  const errors: Error[] = [];
  const pool = new LogIoPool(directory, (error) => errors.push(error), undefined, {
    readLanes: plan.logReadLanes,
    writeLanes: plan.logWriteLanes,
    heapMb: plan.workerHeapMb,
  });
  const http = createServer((_request, response) => response.end("responsive"));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const batchId = randomUUID();
  const content = randomBytes(128 * 1024)
    .toString("base64")
    .slice(0, 128 * 1024);
  const recordedAt = new Date().toISOString();
  const attempts = Array.from({ length: 32 }, (_, i) => `attempt-${i}`);
  let nextAttempt = 0;
  let probing = true;
  let maximumRssBytes = 0;
  const latencies: number[] = [];
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  const probe = (async () => {
    while (probing) {
      const started = performance.now();
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      assert.equal(await response.text(), "responsive");
      latencies.push(performance.now() - started);
      maximumRssBytes = Math.max(maximumRssBytes, process.memoryUsage().rss);
      await delay(20);
    }
  })();
  // Observe rejection immediately even if a disk call is still in progress.
  let probeError: unknown;
  const observedProbe = probe.catch((error) => {
    probeError = error;
  });
  try {
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (nextAttempt < attempts.length) {
          const attemptId = attempts[nextAttempt++]!;
          for (let sequence = 0; sequence < 64; sequence += 4) {
            const result = await pool.call("appendChunks", [
              {
                batchId,
                attemptId,
                receivedAt: recordedAt,
                chunks: Array.from({ length: 4 }, (_, index) => ({
                  stream: "stdout",
                  sequence: sequence + index,
                  content,
                  recordedAt,
                })),
              },
            ]);
            assert.deepEqual(result, { stdout: sequence + 3, stderr: -1, agent: -1 });
          }
        }
      }),
    );
    const durationMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuBefore);
    probing = false;
    await observedProbe;
    if (probeError) throw probeError;
    assert.equal(errors.length, 0, errors.map((error) => error.message).join("\n"));
    for (const attemptId of attempts) {
      const page = await pool.call("listChunks", [
        { batchId, attemptId, stream: "stdout", afterSequence: 62, limit: 1 },
      ]);
      assert.equal((page as { items: Array<{ content: string }> }).items[0]?.content, content);
    }
    latencies.sort((a, b) => a - b);
    const p95HttpMs = latencies[Math.floor(latencies.length * 0.95)]!;
    assert(p95HttpMs < 1_500, `HTTP P95 ${p95HttpMs} ms`);
    assert(
      maximumRssBytes < resources.memoryCapacityBytes * 0.8,
      "RSS exceeded container safety budget",
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          resources,
          plan,
          uploadedBytes: 32 * 64 * content.length,
          durationMs,
          throughputMiBPerSecond: 256 / (durationMs / 1_000),
          averageCpuCores: (cpu.user + cpu.system) / (durationMs * 1_000),
          maximumRssBytes,
          p95HttpMs,
          maximumHttpMs: latencies.at(-1),
          probes: latencies.length,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    probing = false;
    await observedProbe;
    await pool.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
