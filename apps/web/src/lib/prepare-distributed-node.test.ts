import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  PlatformConfigurationStore,
  persistedPlatformConfigurationSchema,
} from "@autoforge/platform-config";
import { prepareDistributedNode } from "./prepare-distributed-node";

describe("distributed node preparation", () => {
  it("preserves shared configuration, creates distinct node identities, and refuses overwriting deployed files", () => {
    const directory = mkdtempSync(join(tmpdir(), "prepare-platform-node-"));
    try {
      const source = new PlatformConfigurationStore(join(directory, "source")).initialize();
      const originalFile = join(directory, "original/config/platform.json");
      expect(() => prepareDistributedNode(source, originalFile, "original")).toThrow("Full");
      const full = persistedPlatformConfigurationSchema.parse({
        ...source,
        mode: "full",
        full: {
          databaseUrl: "postgresql://localhost/autoforge",
          databasePoolMax: 10,
          natsServers: ["nats://localhost:4222"],
          natsToken: "isolated-test-token",
          redisUrl: "redis://localhost:6379",
          minio: {
            endpoint: "http://localhost:9000",
            accessKey: "test",
            secretKey: "test-secret",
            bucket: "objects",
            region: "us-east-1",
          },
        },
      });
      expect(prepareDistributedNode(full, originalFile, "original")).toBe(source.nodeId);
      const replicaFile = join(directory, "replica/config/platform.json");
      const replicaId = prepareDistributedNode(full, replicaFile, "new");
      expect(replicaId).not.toBe(source.nodeId);
      const replica = persistedPlatformConfigurationSchema.parse(
        JSON.parse(readFileSync(replicaFile, "utf8")),
      );
      expect(replica).toEqual({ ...full, deployment: "distributed", nodeId: replicaId });
      expect(statSync(replicaFile).mode & 0o777).toBe(0o600);
      expect(statSync(join(directory, "replica/config")).mode & 0o777).toBe(0o700);
      expect(() => prepareDistributedNode(full, replicaFile, "new")).toThrow("EEXIST");
      expect(JSON.parse(readFileSync(replicaFile, "utf8"))).toEqual(replica);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
