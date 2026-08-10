import { connect, type NatsConnection } from "nats";
import { describe } from "vitest";

import { JetStreamJobQueue } from "../src/jetstream";
import { jobQueueContract, type JobQueueHarness } from "./job-queue.contract";

const natsUrl = process.env.AUTOFORGE_TEST_NATS_URL;
const describeWithNats = natsUrl ? describe : describe.skip;
let namespaceSequence = 0;

describeWithNats("JetStream integration", () => {
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
