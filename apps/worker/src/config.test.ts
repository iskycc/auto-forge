import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config";

describe("worker configuration", () => {
  it("reads the artifact collection switch again for scheduled batches", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autoforge-worker-config-"));
    const store = new PlatformConfigurationStore(dataDirectory);
    const current = store.initialize(new Date("2026-08-24T00:00:00.000Z"));
    const fullConfiguration = store.replace(
      {
        ...current,
        mode: "full",
        full: {
          databaseUrl: "postgresql://autoforge:secret@postgres:5432/autoforge",
          databasePoolMax: 10,
          natsServers: ["nats://nats:4222"],
          redisUrl: "redis://redis:6379",
          minio: {
            endpoint: "http://minio:9000",
            accessKey: "autoforge",
            secretKey: "secret",
            bucket: "autoforge-objects",
            region: "us-east-1",
          },
        },
      },
      current.revision,
    );
    const worker = loadWorkerConfig({ dataDirectory, workspaceRoot: "/workspace" });

    expect(worker.artifactCollectionEnabled()).toBe(true);

    store.replace(
      {
        ...fullConfiguration,
        limits: { ...fullConfiguration.limits, artifactCollectionEnabled: false },
      },
      fullConfiguration.revision,
    );

    expect(worker.artifactCollectionEnabled()).toBe(false);
  });
});
