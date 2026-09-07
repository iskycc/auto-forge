import { connect, type NatsConnection } from "nats";
import { describe, it, expect } from "vitest";

import { JetStreamJobQueue } from "../src/jetstream";
import { jobQueueContract, type JobQueueHarness } from "./job-queue.contract";

const natsUrl = process.env.AUTOFORGE_TEST_NATS_URL;
const describeWithNats = natsUrl ? describe : describe.skip;
let namespaceSequence = 0;

describeWithNats("JetStream integration", () => {
  it("routes persisted mixed-queue background jobs before acknowledging their legacy delivery", async () => {
    const connection = await connect({ servers: natsUrl! });
    const manager = await connection.jetstreamManager();
    const namespace = `legacy_${process.pid}_${namespaceSequence++}`;
    const streamName = `AUTOFORGE_JOBS_V1_${namespace.toUpperCase()}`;
    const queue = await JetStreamJobQueue.create(connection.jetstream(), manager, { namespace });
    const now = new Date().toISOString();
    const job = {
      schemaVersion: 1,
      messageId: "legacy-import",
      runId: "legacy-import",
      attempt: 1,
      createdAt: now,
      priority: 0,
      deduplicationKey: "legacy-import",
      kind: "jar-import",
      payload: { jobId: "legacy-import" },
    };
    try {
      await connection
        .jetstream()
        .publish(
          `autoforge.jobs.v1.${namespace.replaceAll("_", "-")}.ready`,
          new TextEncoder().encode(JSON.stringify(job)),
        );
      const request = {
        workerId: "migration",
        now,
        leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
        limit: 1,
      };
      expect(await queue.claim({ ...request, workClass: "execution" })).toEqual([]);
      const [moved] = await queue.claim({ ...request, workClass: "background" });
      expect(moved?.job.messageId).toBe(job.messageId);
      await queue.acknowledge({
        workerId: "migration",
        deliveryId: moved!.deliveryId,
        acknowledgedAt: now,
      });
      expect(await queue.depth()).toEqual({ available: 0, leased: 0, deadLetter: 0 });
    } finally {
      await queue.close();
      await manager.streams.delete(streamName);
      await connection.drain();
    }
  });
  jobQueueContract("JetStream job queue", async (testId): Promise<JobQueueHarness> => {
    const connection = await connect({ servers: natsUrl! });
    const manager = await connection.jetstreamManager();
    const jetStream = connection.jetstream();
    const namespace = `test_${process.pid}_${namespaceSequence++}_${testId}`;
    const streamName = `AUTOFORGE_JOBS_V1_${namespace.toUpperCase()}`;
    const createQueue = () =>
      JetStreamJobQueue.create(jetStream, manager, {
        namespace,
        acknowledgementWaitMs: 200,
        maximumDeliveries: 8,
      });
    let queue = await createQueue();

    return {
      queue,
      async restart() {
        await queue.close();
        queue = await createQueue();
        return queue;
      },
      async dispose() {
        await queue.close();
        await deleteStream(manager, streamName);
        await connection.drain();
      },
    };
  });
});

async function deleteStream(
  manager: Awaited<ReturnType<NatsConnection["jetstreamManager"]>>,
  streamName: string,
): Promise<void> {
  try {
    await manager.streams.delete(streamName);
  } catch (error) {
    if (!String(error).includes("stream not found")) throw error;
  }
}
