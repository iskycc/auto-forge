import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LogStreamGateway } from "./log-stream-gateway.ts";
import { LogStreamRelay } from "./log-stream-relay.ts";

const redisUrl = process.env.AUTOFORGE_TEST_REDIS_URL;
describe.skipIf(!redisUrl)("Redis real-time logs", () => {
  it("relays across replicas and replays only a bounded recent cache", async () => {
    const gateways = [
      new LogStreamGateway("test-secret", vi.fn()),
      new LogStreamGateway("test-secret", vi.fn()),
    ];
    const observed = vi.spyOn(gateways[1]!, "publish");
    const relays = await Promise.all(
      gateways.map((gateway) =>
        LogStreamRelay.create({ mode: "full", redisUrl: redisUrl!, gateway, logger: vi.fn() }),
      ),
    );
    const attemptId = randomUUID();
    try {
      const chunks = [
        {
          stream: "stdout" as const,
          sequence: 0,
          content: "from replica A",
          recordedAt: "2026-09-05T00:00:00.000Z",
        },
      ];
      relays[0]!.publish(attemptId, chunks);
      await vi.waitFor(() => expect(observed).toHaveBeenCalledWith(attemptId, chunks));
      expect(await relays[1]!.recent(attemptId)).toEqual(chunks);
      for (let sequence = 1; sequence <= 36; sequence++) {
        relays[0]!.publish(attemptId, [{ ...chunks[0]!, sequence, content: "x".repeat(16000) }]);
        await vi.waitFor(() =>
          expect(observed).toHaveBeenCalledWith(
            attemptId,
            expect.arrayContaining([expect.objectContaining({ sequence })]),
          ),
        );
      }
      const recent = await relays[1]!.recent(attemptId);
      expect(recent.length).toBeLessThanOrEqual(32);
      expect(Buffer.byteLength(JSON.stringify(recent))).toBeLessThan(262144);
      expect(recent.at(-1)?.sequence).toBe(36);
      expect(await relays[1]!.recent(randomUUID())).toEqual([]);
    } finally {
      for (const relay of relays) await relay.close();
      for (const gateway of gateways) await gateway.close();
    }
  });
});
