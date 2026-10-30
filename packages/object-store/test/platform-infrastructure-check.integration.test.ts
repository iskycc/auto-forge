import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import {
  platformInfrastructureCheckSchema,
  type PlatformInfrastructureCheck,
} from "@autoforge/contracts";
import { checkPlatformInfrastructure } from "../../../apps/web/server/platform-infrastructure-check";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const redisUrl = process.env.AUTOFORGE_TEST_REDIS_URL;
const natsUrl = process.env.AUTOFORGE_TEST_NATS_URL;
const minioUrl = process.env.AUTOFORGE_TEST_MINIO_ENDPOINT;
const accessKey = process.env.AUTOFORGE_TEST_MINIO_ACCESS_KEY;
const secretKey = process.env.AUTOFORGE_TEST_MINIO_SECRET_KEY;
const bucket = `af-setup-${randomUUID()}`;

describe.skipIf(!postgresUrl || !redisUrl || !natsUrl || !minioUrl || !accessKey || !secretKey)(
  "Full guided infrastructure checks",
  () => {
    let targets: PlatformInfrastructureCheck[];
    let removeBucket: () => Promise<void>;
    beforeAll(async () => {
      const postgres = new URL(postgresUrl!);
      const redis = new URL(redisUrl!);
      const nats = new URL(natsUrl!);
      const minio = new URL(minioUrl!);
      const { Client } = await import("minio");
      const client = new Client({
        endPoint: minio.hostname,
        port: Number(minio.port),
        useSSL: false,
        accessKey: accessKey!,
        secretKey: secretKey!,
      });
      await client.makeBucket(bucket);
      removeBucket = async () => {
        const objects = await client.listObjectsV2(bucket).toArray();
        expect(objects).toEqual([]);
        await client.removeBucket(bucket);
      };
      const credentials = {
        host: postgres.hostname,
        port: Number(postgres.port),
        username: decodeURIComponent(postgres.username),
        password: decodeURIComponent(postgres.password),
      };
      targets = [
        {
          component: "postgres",
          connection: { ...credentials, database: postgres.pathname.slice(1) },
        },
        {
          component: "logs",
          connection: {
            ...credentials,
            name: "日志库",
            maintenanceDatabase: "postgres",
          },
        },
        {
          component: "redis",
          connection: {
            host: redis.hostname,
            port: Number(redis.port),
            password: decodeURIComponent(redis.password),
          },
        },
        {
          component: "nats",
          connection: {
            host: nats.hostname,
            port: Number(nats.port),
            token: process.env.AUTOFORGE_TEST_NATS_TOKEN ?? "",
          },
        },
        {
          component: "minio",
          connection: {
            host: minio.hostname,
            port: Number(minio.port),
            accessKey,
            secretKey,
            bucket,
          },
        },
      ].map((target) => platformInfrastructureCheckSchema.parse(target));
    });
    afterAll(async () => {
      if (removeBucket) await removeBucket();
    });
    it("verifies all five components with real authenticated services", async () => {
      for (const target of targets) {
        const result = await checkPlatformInfrastructure(target);
        expect(result, `${target.component}: ${result.message}`).toMatchObject({ ok: true });
      }
    });
    it("identifies bad PostgreSQL credentials without leaking them", async () => {
      const target = targets.find((target) => target.component === "postgres")!;
      const result = await checkPlatformInfrastructure({
        ...target,
        connection: { ...target.connection, password: "wrong-private-password" },
      } as PlatformInfrastructureCheck);
      expect(result).toMatchObject({ ok: false });
      expect(result.message).toContain("用户名或密码");
      expect(result.message).not.toContain("wrong-private-password");
    });
    it("identifies a missing bucket and leaves no test objects", async () => {
      const target = targets.find((target) => target.component === "minio")!;
      const result = await checkPlatformInfrastructure({
        ...target,
        connection: { ...target.connection, bucket: "missing-" + randomUUID() },
      } as PlatformInfrastructureCheck);
      expect(result).toMatchObject({ ok: false });
      expect(result.message).toContain("Bucket 不存在");
    });
  },
);

describe("bounded initialization checks", () => {
  let listener: Server;
  const sockets = new Set<Socket>();
  let port: number;
  beforeAll(async () => {
    listener = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("No port");
    port = address.port;
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  });
  it.each(["postgres", "redis", "nats", "minio"] as const)(
    "does not hang when %s accepts a socket but never responds",
    async (component) => {
      const target = platformInfrastructureCheckSchema.parse({
        component,
        connection: {
          host: "127.0.0.1",
          port,
          username: "fixture",
          password: "fixture",
          database: component === "redis" ? 0 : "fixture",
          accessKey: "fixture",
          secretKey: "fixture-secret",
          bucket: "fixture",
        },
      });
      const result = await checkPlatformInfrastructure(target);
      expect(result.ok).toBe(false);
      expect(result.durationMs).toBeLessThan(12000);
    },
    15000,
  );
});
