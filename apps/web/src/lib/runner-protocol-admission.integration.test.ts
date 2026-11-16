import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { expect, it } from "vitest";
import { RedisRequestLimiter } from "./request-limiter";
import { createRunnerProtocolAdmission } from "./runner-protocol-admission";

it.skipIf(!process.env.AUTOFORGE_TEST_REDIS_URL)(
  "shares the 1000-upload Full budget between independent Redis clients",
  async () => {
    const clients = [
      createClient({ url: process.env.AUTOFORGE_TEST_REDIS_URL! }),
      createClient({ url: process.env.AUTOFORGE_TEST_REDIS_URL! }),
    ];
    const prefix = `log-admission-test:${randomUUID()}:`;
    try {
      await Promise.all(clients.map((client) => client.connect()));
      const admissions = clients.map((client) =>
        createRunnerProtocolAdmission(
          new RedisRequestLimiter((script, options) =>
            client.eval(script, { ...options, keys: options.keys.map((key) => prefix + key) }),
          ),
          { requests: 1_000, windowMs: 60_000 },
        ),
      );
      // A long test window removes machine-speed races; the one-second reset is
      // separately verified with a controlled clock in the admission unit test.
      const uploads = await Promise.allSettled(
        Array.from({ length: 1_001 }, (_, index) =>
          admissions[index % 2]!.assertAllowed({
            operation: "logs",
            runnerId: `runner-${index}`,
            maximumConcurrency: 1,
          }),
        ),
      );
      expect(uploads.filter((result) => result.status === "fulfilled")).toHaveLength(1_000);
      expect(uploads.filter((result) => result.status === "rejected")).toMatchObject([
        { reason: { code: "RATE_LIMITED" } },
      ]);
      await expect(
        admissions[0]!.assertAllowed({
          operation: "renew-lease",
          runnerId: "runner",
          maximumConcurrency: 1,
        }),
      ).resolves.toBeUndefined();
      await clients[0]!.del(prefix + "autoforge:rate:v1:runner:logs:platform:v3");
      await clients[0]!.del(prefix + "autoforge:rate:v1:runner:renew-lease:node:v2:runner");
    } finally {
      await Promise.all(
        clients.map((client) => (client.isOpen ? client.close() : Promise.resolve())),
      );
    }
  },
);
