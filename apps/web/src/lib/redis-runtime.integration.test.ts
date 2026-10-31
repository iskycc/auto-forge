import { createClient } from "redis";
import { describe, expect, it } from "vitest";
import { RedisCache } from "@autoforge/cache/redis";
import { redisRuntimeCommandOptions, awaitRedisReply } from "./resilient-connections";
const url = process.env.AUTOFORGE_TEST_REDIS_URL;
describe.skipIf(!url)("bounded Redis runtime commands", () => {
  it("fails offline commands immediately, reads real usage and recovers after a timed-out command", async () => {
    const client = createClient({
      url: url!,
      ...redisRuntimeCommandOptions,
      socket: { connectTimeout: 1000, reconnectStrategy: false },
    });
    client.on("error", () => {});
    await expect(client.get("offline")).rejects.toThrow();
    await client.connect();
    try {
      const usage = await new RedisCache(client).readUsage();
      expect(usage.metrics).toContainEqual(
        expect.objectContaining({ key: "used_memory", value: expect.any(Number) }),
      );
      await expect(
        awaitRedisReply(client.blPop("autoforge:diagnostic-timeout-fixture", 5)),
      ).rejects.toThrow(/exceeded/i);
      expect(await client.ping()).toBe("PONG");
    } finally {
      client.destroy();
    }
  }, 15000);
});
