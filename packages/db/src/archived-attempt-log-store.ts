import type { PoolClient } from "pg";
import { DomainError } from "@autoforge/domain";
import type {
  LogArchiveRepository,
  JarObjectStorePort,
  ArchivedBatchLocation,
} from "@autoforge/application";
import type { AttemptLogStore, AsyncAttemptLogStore, AttemptLogStream } from "./attempt-log-store";
import { LogArchiveReader } from "./log-archive-reader";
export class ArchivedAttemptLogStore implements AsyncAttemptLogStore {
  readonly storesWatermarksInBusinessDatabase: boolean;
  private readonly reader: LogArchiveReader;
  constructor(
    private readonly original: AttemptLogStore | AsyncAttemptLogStore,
    private readonly archives: LogArchiveRepository,
    objects: JarObjectStorePort,
  ) {
    this.reader = new LogArchiveReader(objects);
    this.storesWatermarksInBusinessDatabase = hasBusinessLogWatermarks(original);
  }
  async appendChunks(input: Parameters<AttemptLogStore["appendChunks"]>[0]) {
    if (await this.archives.archivedBatch(input.batchId))
      throw new DomainError("LOG_ARCHIVE_READ_ONLY", "此批次日志已归档，不能追加写入。");
    return this.original.appendChunks(input);
  }
  async listChunks(input: Parameters<AttemptLogStore["listChunks"]>[0]) {
    const location = await this.archives.archivedBatch(input.batchId);
    if (location) return this.readArchive(location, input);
    const page = await this.original.listChunks(input);
    // Cutover is persisted before deletion. Rechecking prevents a concurrent cleanup
    // from turning a page that began on the original store into an empty/truncated log.
    const cutover = await this.archives.archivedBatch(input.batchId);
    return cutover ? this.readArchive(cutover, input) : page;
  }
  private async readArchive(
    location: ArchivedBatchLocation,
    input: Parameters<AttemptLogStore["listChunks"]>[0],
  ) {
    assertArchiveOnline(location);
    try {
      return await this.reader.list(location, input);
    } catch (cause) {
      // A concurrent confirmed removal must report offline status instead of a broken or empty log.
      const current = await this.archives.archivedBatch(input.batchId);
      if (current) assertArchiveOnline(current);
      throw cause;
    }
  }
  async acknowledgedSequence(
    batchId: string,
    attemptId: string,
    stream: AttemptLogStream,
    client?: Pick<PoolClient, "query">,
  ) {
    if (client && hasBusinessLogWatermarks(this.original))
      return this.original.acknowledgedSequence(batchId, attemptId, stream, client);
    const location = await this.archives.archivedBatch(batchId);
    if (location && !hasBusinessLogWatermarks(this.original)) {
      assertArchiveOnline(location);
      return this.reader.acknowledgedSequence(location, batchId, attemptId, stream);
    }
    return this.original.acknowledgedSequence(batchId, attemptId, stream);
  }
  async recordWatermarks(
    input: Parameters<AttemptLogStore["recordWatermarks"]>[0],
    client?: Pick<PoolClient, "query">,
  ) {
    if (client && hasBusinessLogWatermarks(this.original))
      return this.original.recordWatermarks(input, client);
    return this.original.recordWatermarks(input);
  }
  async removeBatchStore(batchId: string) {
    if (!(await this.archives.archivedBatch(batchId)))
      await this.original.removeBatchStore(batchId);
  }
  async batchStoreStats(batchIds: readonly string[]) {
    return this.original.batchStoreStats(batchIds);
  }
  async directoryBytes() {
    return this.original.directoryBytes();
  }
  relativeStorePath(batchId: string) {
    return this.original.relativeStorePath(batchId);
  }
  async close() {
    await this.original.close();
  }
}
export function hasBusinessLogWatermarks(
  store: AttemptLogStore | AsyncAttemptLogStore,
): store is AsyncAttemptLogStore & {
  storesWatermarksInBusinessDatabase: true;
  acknowledgedSequence(
    batchId: string,
    attemptId: string,
    stream: AttemptLogStream,
    client?: Pick<PoolClient, "query">,
  ): Promise<number>;
  recordWatermarks(
    input: Parameters<AttemptLogStore["recordWatermarks"]>[0],
    client?: Pick<PoolClient, "query">,
  ): Promise<void>;
} {
  return (
    "storesWatermarksInBusinessDatabase" in store &&
    store.storesWatermarksInBusinessDatabase === true
  );
}

function assertArchiveOnline(location: ArchivedBatchLocation): void {
  if (location.offline)
    throw new DomainError(
      "LOG_ARCHIVE_OFFLINE",
      "此日志已离线归档，平台副本已确认下载后移除或正在移除。请使用已下载的归档包查看；执行记录和结果仍然保留。",
    );
}
