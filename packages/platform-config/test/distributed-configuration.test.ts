import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import {
  PlatformConfigurationStore,
  persistedPlatformConfigurationSchema,
} from "../src/platform-configuration";

describe("distributed deployment configuration", () => {
  it("retains a node identity and rejects local changes that would split cluster configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "distributed-config-"));
    try {
      const store = new PlatformConfigurationStore(directory);
      const current = store.initialize();
      expect(store.initialize().nodeId).toBe(current.nodeId);
      expect(() =>
        persistedPlatformConfigurationSchema.parse({ ...current, deployment: "distributed" }),
      ).toThrow("Full 模式");
      const full = {
        ...current,
        mode: "full" as const,
        deployment: "distributed" as const,
        full: {
          databaseUrl: "postgresql://localhost/autoforge",
          databasePoolMax: 10,
          natsServers: ["nats://localhost:4222"],
          redisUrl: "redis://localhost:6379",
          minio: {
            endpoint: "http://localhost:9000",
            accessKey: "test",
            secretKey: "test-secret",
            bucket: "objects",
            region: "us-east-1",
          },
        },
      };
      expect(() =>
        persistedPlatformConfigurationSchema.parse({ ...full, nodeId: undefined }),
      ).toThrow("节点 ID");
      const saved = store.replace(full, current.revision);
      expect(() => store.replace({ ...saved, deployment: "single-host" }, saved.revision)).toThrow(
        "统一管理",
      );
      expect(store.read()).toEqual(saved);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
