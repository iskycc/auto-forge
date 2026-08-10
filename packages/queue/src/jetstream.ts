import type { ClaimedJob, JobQueuePort } from "@autoforge/application";
import { jobEnvelopeSchema, type JobEnvelope } from "@autoforge/contracts";
import {
  AckPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  headers,
  nanos,
  StringCodec,
  type Consumer,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
} from "nats";

const codec = StringCodec();

const defaultSettings: JetStreamQueueSettings = {
  streamName: "AUTOFORGE_JOBS_V1",
  readySubject: "autoforge.jobs.v1.ready",
  deadLetterSubject: "autoforge.jobs.v1.dead",
  durableName: "autoforge-dispatcher-v1",
  acknowledgementWaitMs: 30_000,
  maximumDeliveries: 8,
};

export type JetStreamJobQueueOptions = {
  namespace?: string;
  acknowledgementWaitMs?: number;
  maximumDeliveries?: number;
};

type JetStreamQueueSettings = {
  streamName: string;
  readySubject: string;
  deadLetterSubject: string;
  durableName: string;
  acknowledgementWaitMs: number;
  maximumDeliveries: number;
};

type ActiveDelivery = { message: JsMsg; job: JobEnvelope; workerId: string };

export class JetStreamJobQueue implements JobQueuePort {
  private readonly active = new Map<string, ActiveDelivery>();

  private constructor(
    private readonly jetStream: JetStreamClient,
    private readonly manager: JetStreamManager,
    private readonly consumer: Consumer,
    private readonly settings: JetStreamQueueSettings,
  ) {}

  static async create(
    jetStream: JetStreamClient,
    manager: JetStreamManager,
    options: JetStreamJobQueueOptions = {},
  ) {
    const settings = createSettings(options);
    await ensureStream(manager, settings);
    await ensureConsumer(manager, settings);
    const consumer = await jetStream.consumers.get(settings.streamName, settings.durableName);
    return new JetStreamJobQueue(jetStream, manager, consumer, settings);
  }

  async publish(jobInput: JobEnvelope, availableAt: string = jobInput.createdAt) {
    const job = jobEnvelopeSchema.parse(jobInput);
    const messageHeaders = headers();
    messageHeaders.set("AutoForge-Available-At", availableAt);
    const acknowledgement = await this.jetStream.publish(
      this.settings.readySubject,
      codec.encode(JSON.stringify(job)),
      { msgID: job.deduplicationKey, headers: messageHeaders },
    );
    return acknowledgement.duplicate ? "duplicate" : "published";
  }

  async claim(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<ClaimedJob[]> {
    if (!input.workerId || input.limit < 1 || input.limit > 256) {
      throw new Error("JetStream claim request is invalid.");
    }
    const claimed: ClaimedJob[] = [];
    const consumerInfo = await this.consumer.info();
    const maximumMessages = Math.min(input.limit, Math.max(1, consumerInfo.num_pending));
    const messages = await this.consumer.fetch({ max_messages: maximumMessages, expires: 1_000 });
    for await (const message of messages) {
      let job: JobEnvelope;
      try {
        job = jobEnvelopeSchema.parse(JSON.parse(codec.decode(message.data)));
      } catch {
        message.term("invalid AutoForge job envelope");
        continue;
      }
      const availableAt = message.headers?.get("AutoForge-Available-At");
      if (availableAt && availableAt > input.now) {
        message.nak(Math.max(100, new Date(availableAt).getTime() - new Date(input.now).getTime()));
        continue;
      }
      if (availableAt && availableAt > job.createdAt) {
        await this.promoteDeferredMessage(message, job);
        continue;
      }
      const deliveryId = `${message.info.streamSequence}:${message.info.deliverySequence}`;
      this.active.set(deliveryId, { message, job, workerId: input.workerId });
      claimed.push({
        job,
        deliveryId,
        leaseExpiresAt: input.leaseExpiresAt,
        deliveryAttempt: message.info.deliveryCount,
      });
    }
    return claimed;
  }

  async renew(input: {
    workerId: string;
    deliveryId: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<boolean> {
    const delivery = this.active.get(input.deliveryId);
    if (!delivery || delivery.workerId !== input.workerId) return false;
    delivery.message.working();
    return true;
  }

  async acknowledge(input: {
    workerId: string;
    deliveryId: string;
    acknowledgedAt: string;
  }): Promise<void> {
    const delivery = this.active.get(input.deliveryId);
    if (!delivery) return;
    if (delivery.workerId !== input.workerId) {
      throw new Error("Job delivery is not owned by this worker.");
    }
    if (!(await delivery.message.ackAck({ timeout: 5_000 }))) {
      throw new Error("JetStream did not confirm the job acknowledgement.");
    }
    this.active.delete(input.deliveryId);
  }

  async reject(input: {
    workerId: string;
    deliveryId: string;
    errorCode: string;
    errorSummary: string;
    retryAt?: string;
    rejectedAt: string;
  }): Promise<"retrying" | "dead_letter"> {
    const delivery = this.active.get(input.deliveryId);
    if (!delivery) throw new Error("JetStream delivery is no longer active.");
    if (delivery.workerId !== input.workerId) {
      throw new Error("Job delivery is not owned by this worker.");
    }
    if (delivery.message.info.deliveryCount >= this.settings.maximumDeliveries) {
      await this.jetStream.publish(
        this.settings.deadLetterSubject,
        codec.encode(
          JSON.stringify({
            ...delivery.job,
            deadLetter: { code: input.errorCode, summary: input.errorSummary },
          }),
        ),
        { msgID: `${delivery.job.messageId}:dead` },
      );
      delivery.message.term(input.errorCode);
      this.active.delete(input.deliveryId);
      return "dead_letter";
    }
    const delay = input.retryAt
      ? Math.max(100, new Date(input.retryAt).getTime() - new Date(input.rejectedAt).getTime())
      : 1_000;
    delivery.message.nak(delay);
    this.active.delete(input.deliveryId);
    return "retrying";
  }

  async recoverExpired(): Promise<number> {
    return 0;
  }

  async depth(): Promise<{ available: number; leased: number; deadLetter: number }> {
    const [consumer, stream] = await Promise.all([
      this.manager.consumers.info(this.settings.streamName, this.settings.durableName),
      this.manager.streams.info(this.settings.streamName, {
        subjects_filter: this.settings.deadLetterSubject,
      }),
    ]);
    return {
      available: consumer.num_pending,
      leased: consumer.num_ack_pending,
      deadLetter: stream.state.subjects?.[this.settings.deadLetterSubject] ?? 0,
    };
  }

  async ready(): Promise<void> {
    await Promise.all([
      this.manager.streams.info(this.settings.streamName),
      this.manager.consumers.info(this.settings.streamName, this.settings.durableName),
    ]);
  }

  async close(): Promise<void> {
    this.active.clear();
  }

  private async promoteDeferredMessage(message: JsMsg, job: JobEnvelope): Promise<void> {
    const readyHeaders = headers();
    readyHeaders.set("AutoForge-Available-At", job.createdAt);
    await this.jetStream.publish(this.settings.readySubject, message.data, {
      msgID: `autoforge-deferred:${message.info.streamSequence}`,
      headers: readyHeaders,
    });
    if (!(await message.ackAck({ timeout: 5_000 }))) {
      throw new Error("JetStream did not confirm the deferred job promotion.");
    }
  }
}

async function ensureStream(
  manager: JetStreamManager,
  settings: JetStreamQueueSettings,
): Promise<void> {
  try {
    const existing = await manager.streams.info(settings.streamName);
    if (
      existing.config.retention !== RetentionPolicy.Limits ||
      existing.config.storage !== StorageType.File ||
      existing.config.discard !== DiscardPolicy.Old
    ) {
      throw new Error(
        `JetStream stream ${settings.streamName} has incompatible immutable settings.`,
      );
    }
    await manager.streams.update(settings.streamName, {
      ...existing.config,
      subjects: [settings.readySubject, settings.deadLetterSubject],
      max_age: nanos(30 * 24 * 60 * 60 * 1_000),
      max_msgs: 1_000_000,
      duplicate_window: nanos(24 * 60 * 60 * 1_000),
    });
    return;
  } catch (error) {
    if (!isMissingJetStreamResource(error)) throw error;
    await manager.streams.add({
      name: settings.streamName,
      subjects: [settings.readySubject, settings.deadLetterSubject],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_age: nanos(30 * 24 * 60 * 60 * 1_000),
      max_msgs: 1_000_000,
      duplicate_window: nanos(24 * 60 * 60 * 1_000),
    });
  }
}

async function ensureConsumer(
  manager: JetStreamManager,
  settings: JetStreamQueueSettings,
): Promise<void> {
  try {
    const existing = await manager.consumers.info(settings.streamName, settings.durableName);
    if (existing.config.ack_policy !== AckPolicy.Explicit) {
      throw new Error(
        `JetStream consumer ${settings.durableName} must use explicit acknowledgements.`,
      );
    }
    await manager.consumers.update(settings.streamName, settings.durableName, {
      ...existing.config,
      filter_subject: settings.readySubject,
      ack_wait: nanos(settings.acknowledgementWaitMs),
      max_deliver: settings.maximumDeliveries,
      max_ack_pending: 1_024,
    });
    return;
  } catch (error) {
    if (!isMissingJetStreamResource(error)) throw error;
    await manager.consumers.add(settings.streamName, {
      durable_name: settings.durableName,
      name: settings.durableName,
      filter_subject: settings.readySubject,
      ack_policy: AckPolicy.Explicit,
      ack_wait: nanos(settings.acknowledgementWaitMs),
      max_deliver: settings.maximumDeliveries,
      max_ack_pending: 1_024,
    });
  }
}

function createSettings(options: JetStreamJobQueueOptions): JetStreamQueueSettings {
  const acknowledgementWaitMs = options.acknowledgementWaitMs ?? 30_000;
  const maximumDeliveries = options.maximumDeliveries ?? 8;
  if (
    !Number.isInteger(acknowledgementWaitMs) ||
    acknowledgementWaitMs < 100 ||
    acknowledgementWaitMs > 3_600_000
  ) {
    throw new Error("JetStream acknowledgement wait must be between 100 ms and 1 hour.");
  }
  if (!Number.isInteger(maximumDeliveries) || maximumDeliveries < 1 || maximumDeliveries > 100) {
    throw new Error("JetStream maximum deliveries must be between 1 and 100.");
  }
  if (options.namespace === undefined) {
    return { ...defaultSettings, acknowledgementWaitMs, maximumDeliveries };
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(options.namespace)) {
    throw new Error("JetStream queue namespace is invalid.");
  }
  const streamNamespace = options.namespace.toUpperCase();
  const subjectNamespace = options.namespace.toLowerCase().replaceAll("_", "-");
  return {
    streamName: `AUTOFORGE_JOBS_V1_${streamNamespace}`,
    readySubject: `autoforge.jobs.v1.${subjectNamespace}.ready`,
    deadLetterSubject: `autoforge.jobs.v1.${subjectNamespace}.dead`,
    durableName: `autoforge-dispatcher-v1-${subjectNamespace}`,
    acknowledgementWaitMs,
    maximumDeliveries,
  };
}

function isMissingJetStreamResource(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  if (code === "404" || code === "10014") return true;
  if (!("api_error" in error) || !error.api_error || typeof error.api_error !== "object") {
    return false;
  }
  const apiCode = "code" in error.api_error ? Number(error.api_error.code) : 0;
  return apiCode === 404;
}
