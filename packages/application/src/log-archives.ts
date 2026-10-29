import type {
  LogArchiveJob,
  LogArchiveBatch,
  LogArchiveAttempt,
  LogArchiveOptions,
} from "@autoforge/contracts";
import { createLogArchiveSchema } from "@autoforge/contracts";
import type { Clock, IdGenerator } from "./ports";

export type LogArchiveRecord = LogArchiveJob & {
  objectKey?: string;
  indexSha256?: string;
  requestedBy?: string;
  sourceCutoffAt?: string;
  plannedAt?: string;
  nextVolumePending?: boolean;
};
export type ArchivedBatchLocation = {
  archiveId: string;
  objectKey: string;
  indexSha256: string;
  offline?: boolean;
};
export interface LogArchiveRepository {
  create(
    id: string,
    month: string,
    projectId: string | undefined,
    actorId: string,
    now: string,
    options?: LogArchiveOptions,
  ): Promise<LogArchiveJob>;
  list(cursor?: string, actorId?: string): Promise<{ items: LogArchiveJob[]; nextCursor?: string }>;
  find(id: string): Promise<LogArchiveRecord>;
  requestCleanup(id: string, now: string): Promise<void>;
  cancel(id: string, now: string): Promise<void>;
  recordDownload(
    id: string,
    actorId: string,
    sha256: string,
    sizeBytes: number,
    now: string,
  ): Promise<void>;
  requestCopyRemoval(id: string, actorId: string, sha256: string, now: string): Promise<void>;
  retry(id: string, now: string): Promise<void>;
  enqueueNextVolume(id: string, owner: string, nextId: string, now: string): Promise<void>;
  archivedBatch(batchId: string): Promise<ArchivedBatchLocation | undefined>;
  claim(owner: string, now: string, expiresAt: string): Promise<LogArchiveRecord | undefined>;
  renew(owner: string, now: string, expiresAt: string): Promise<boolean>;
  release(owner: string): Promise<void>;
  update(id: string, owner: string, patch: Partial<LogArchiveRecord>, now: string): Promise<void>;
  reserveBatches(
    job: LogArchiveRecord,
    owner: string,
    now: string,
    checkpoint?: () => Promise<void>,
    volume?: {
      maximumSourceBytes: number;
      sizes(batchIds: readonly string[]): Promise<Map<string, number>>;
    },
  ): Promise<number>;
  batches(archiveId: string, cursor?: string): Promise<LogArchiveBatch[]>;
  attempts(batchId: string, cursor?: string): Promise<Omit<LogArchiveAttempt, "streams">[]>;
  batchState(
    archiveId: string,
    batchId: string,
    state: "exported" | "verified" | "cleaning" | "cleaned",
    owner: string,
    now: string,
  ): Promise<void>;
  cleanupBatches(archiveId: string): Promise<string[]>;
  attemptCount(archiveId: string): Promise<number>;
}

export class LogArchiveService {
  constructor(
    private readonly repository: LogArchiveRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}
  list(cursor?: string, actorId?: string) {
    return this.repository.list(cursor, actorId);
  }
  find(id: string) {
    return this.repository.find(id);
  }
  create(input: unknown, actorId: string) {
    const parsed = createLogArchiveSchema.parse(input);
    return this.repository.create(
      this.ids.next(),
      parsed.month,
      parsed.projectId,
      actorId,
      this.clock.now().toISOString(),
      parsed,
    );
  }
  cleanup(id: string) {
    return this.repository.requestCleanup(id, this.clock.now().toISOString());
  }
  cancel(id: string) {
    return this.repository.cancel(id, this.clock.now().toISOString());
  }
  recordDownload(id: string, actorId: string, sha256: string, sizeBytes: number) {
    return this.repository.recordDownload(
      id,
      actorId,
      sha256,
      sizeBytes,
      this.clock.now().toISOString(),
    );
  }
  removeCopy(id: string, actorId: string, sha256: string) {
    return this.repository.requestCopyRemoval(id, actorId, sha256, this.clock.now().toISOString());
  }
  retry(id: string) {
    return this.repository.retry(id, this.clock.now().toISOString());
  }
}
