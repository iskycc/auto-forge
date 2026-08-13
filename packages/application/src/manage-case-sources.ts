import { createHash } from "node:crypto";

import { DomainError, compareCaseSourceSnapshots } from "@autoforge/domain";
import type { CaseSourceSnapshotEntry } from "@autoforge/domain";
import type {
  ConfirmCaseSourceSyncInput,
  DeleteCaseSourceInput,
  UpdateCaseSourceLifecycleInput,
} from "@autoforge/contracts";

import type { JobHandler } from "./run-job-worker";
import type {
  CaseCatalogRepository,
  Clock,
  IdGenerator,
  JarDiscoveryPort,
  JarObjectStorePort,
  JobQueuePort,
} from "./ports";

// 来源目录对比、权威切换、归档与删除的编排。同步语义为“保留”：
// 候选来源成为权威后，只影响后续执行选取的版本；候选中已消失的用例
// 不会被自动禁用或归档，由用户按对比结果自行处理。
export class CaseSourceService {
  constructor(
    private readonly catalog: CaseCatalogRepository,
    private readonly objectStore: JarObjectStorePort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly queue?: JobQueuePort,
    private readonly sourceReader?: JarDiscoveryPort,
  ) {}

  async listObjects(
    input: { cursor?: string; limit: number; prefix?: string },
    projectIds?: readonly string[],
  ) {
    const sources = await this.catalog.listSources(10_000, projectIds);
    const matching = sources
      .filter((source) => !input.prefix || source.objectKey.startsWith(input.prefix))
      .sort((left, right) => left.objectKey.localeCompare(right.objectKey));
    const cursor = input.cursor;
    const start = cursor ? matching.findIndex((source) => source.objectKey > cursor) : 0;
    const pageStart = start < 0 ? matching.length : start;
    const pageSources = matching.slice(pageStart, pageStart + input.limit);
    const hasNextPage = pageStart + pageSources.length < matching.length;
    return {
      storage: this.objectStore.storageKind,
      items: pageSources.map((source) => ({
        objectKey: source.objectKey,
        sizeBytes: source.sizeBytes,
        lastModified: source.updatedAt,
        etag: source.sha256,
      })),
      ...(hasNextPage && pageSources.at(-1) ? { nextCursor: pageSources.at(-1)!.objectKey } : {}),
    } as const;
  }

  async get(sourceId: string, projectIds?: readonly string[]) {
    const source = await this.catalog.getSource(sourceId, projectIds);
    if (!source) {
      throw new DomainError("CASE_SOURCE_NOT_FOUND", "指定的 JAR 来源不存在。");
    }
    return source;
  }

  async readClassSource(sourceId: string, className: string, projectIds?: readonly string[]) {
    const record = await this.get(sourceId, projectIds);
    const candidate = record.inspection.classes.find((item) => item.className === className);
    if (!candidate?.source) return null;
    if (!this.sourceReader) {
      throw new DomainError("SOURCE_VIEW_UNAVAILABLE", "当前运行时未配置源码读取器。");
    }
    const archive = await this.objectStore.read(record.source.objectKey);
    const content = await this.sourceReader.readSource(archive, candidate.source);
    return { reference: candidate.source, content };
  }

  private async requireSource(sourceId: string, projectIds?: readonly string[]) {
    const record = await this.get(sourceId, projectIds);
    return record.source;
  }

  async setAuthoritative(sourceId: string, projectIds?: readonly string[]) {
    const source = await this.catalog.getSource(sourceId, projectIds);
    if (!source) {
      throw new DomainError("CASE_SOURCE_NOT_FOUND", "指定的 JAR 来源不存在。");
    }
    return this.catalog.setAuthoritativeSource(sourceId, source.source.projectId);
  }

  async compareSources(
    candidateSourceId: string,
    actorId?: string,
    projectIds?: readonly string[],
  ) {
    const candidate = await this.requireSource(candidateSourceId, projectIds);
    if (candidate.status !== "ready") {
      throw new DomainError("CASE_SOURCE_NOT_READY", "该来源尚未完成导入，无法参与目录对比。");
    }
    if (candidate.authoritative) {
      throw new DomainError(
        "CASE_SOURCE_ALREADY_AUTHORITATIVE",
        "该来源已是权威来源，无需对比同步。",
      );
    }
    const current = await this.catalog.getAuthoritativeSource(candidate.projectId);
    const [currentSnapshots, candidateSnapshots] = await Promise.all([
      current ? this.catalog.listSourceCaseSnapshots(current.id) : Promise.resolve([]),
      this.catalog.listSourceCaseSnapshots(candidate.id),
    ]);
    const diff = compareCaseSourceSnapshots({
      current: currentSnapshots.map(toSnapshotEntry),
      candidate: candidateSnapshots.map(toSnapshotEntry),
    });
    return this.catalog.createSourceComparison({
      id: this.ids.next(),
      projectId: candidate.projectId,
      ...(current ? { currentSourceId: current.id } : {}),
      candidateSourceId: candidate.id,
      ...diff,
      ...(actorId ? { createdBy: actorId } : {}),
      createdAt: this.clock.now().toISOString(),
    });
  }

  async confirmSync(
    candidateSourceId: string,
    input: ConfirmCaseSourceSyncInput,
    projectIds?: readonly string[],
  ) {
    const candidate = await this.requireSource(candidateSourceId, projectIds);
    const comparison = await this.catalog.getSourceComparison(input.comparisonId);
    if (!comparison) {
      throw new DomainError("CASE_SOURCE_COMPARISON_NOT_FOUND", "指定的对比结果不存在。");
    }
    if (comparison.candidateSourceId !== candidate.id) {
      throw new DomainError(
        "CASE_SOURCE_COMPARISON_MISMATCH",
        "对比结果与该来源不匹配，请重新发起对比。",
      );
    }
    const current = await this.catalog.getAuthoritativeSource(candidate.projectId);
    if ((current?.id ?? null) !== (comparison.currentSourceId ?? null)) {
      throw new DomainError(
        "CASE_SOURCE_SYNC_STALE",
        "权威来源在对比后已变化，请重新对比后再确认同步。",
      );
    }
    return this.catalog.promoteAuthoritativeSource({
      sourceId: candidate.id,
      expectedRevision: input.expectedRevision,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  async updateLifecycle(
    sourceId: string,
    input: UpdateCaseSourceLifecycleInput,
    projectIds?: readonly string[],
  ) {
    await this.get(sourceId, projectIds);
    return this.catalog.updateSourceLifecycle({
      sourceId,
      expectedRevision: input.expectedRevision,
      lifecycleStatus: input.archived ? "archived" : "active",
      updatedAt: this.clock.now().toISOString(),
    });
  }

  async deleteSource(
    sourceId: string,
    input: DeleteCaseSourceInput,
    projectIds?: readonly string[],
  ) {
    const source = await this.requireSource(sourceId, projectIds);
    if (source.authoritative) {
      throw new DomainError("CASE_SOURCE_AUTHORITATIVE", "权威来源不能删除，请先切换权威来源。");
    }
    if (source.lifecycleStatus !== "active") {
      throw new DomainError("CASE_SOURCE_NOT_DELETABLE", "只有活跃状态的来源可以删除。");
    }
    const references = await this.catalog.countSourceReferences(sourceId);
    if (references.caseDefinitions > 0 || references.executionRuns > 0) {
      throw new DomainError(
        "CASE_SOURCE_IN_USE",
        `该来源仍被 ${references.caseDefinitions} 个用例定义和 ${references.executionRuns} 条执行记录引用，请先归档而不是删除。`,
        { details: references },
      );
    }
    if (!this.queue) {
      throw new Error("CaseSourceService 未配置任务队列，无法调度来源删除。");
    }
    const now = this.clock.now().toISOString();
    const cleanupJobId = this.ids.next();
    const updated = await this.catalog.enqueueSourceDeletion({
      sourceId,
      expectedRevision: input.expectedRevision,
      cleanupJobId,
      objectKey: source.objectKey,
      availableAt: now,
      updatedAt: now,
    });
    await this.queue.publish({
      schemaVersion: 1 as const,
      messageId: this.ids.next(),
      runId: cleanupJobId,
      attempt: 1,
      createdAt: now,
      priority: 0,
      deduplicationKey: `object-cleanup:${cleanupJobId}`,
      kind: "object-cleanup" as const,
      payload: { cleanupJobId },
    });
    return updated;
  }

  // 对象清理任务处理器：删除来源 JAR 对象并标记清理完成。
  // 重复投递时清理任务已 succeeded，直接返回保持幂等。
  objectCleanupHandler(): JobHandler {
    return async (job) => {
      const cleanupJobId = job.payload.cleanupJobId;
      if (typeof cleanupJobId !== "string" || cleanupJobId.length === 0) {
        throw new Error("Object cleanup job payload is invalid.");
      }
      const cleanupJob = await this.catalog.getCleanupJob(cleanupJobId);
      if (!cleanupJob || cleanupJob.status === "succeeded") return;
      if (cleanupJob.objectKey) {
        await this.objectStore.delete(cleanupJob.objectKey);
      }
      await this.catalog.completeCleanupJob({
        id: cleanupJob.id,
        status: "succeeded",
        attemptCount: cleanupJob.attemptCount + 1,
        finishedAt: this.clock.now().toISOString(),
      });
    };
  }
}

function toSnapshotEntry(snapshot: {
  caseDefinitionId: string;
  className: string;
  snapshotJson: string;
}): CaseSourceSnapshotEntry {
  return {
    className: snapshot.className,
    caseDefinitionId: snapshot.caseDefinitionId,
    signature: createHash("sha256")
      .update(canonicalJson(JSON.parse(snapshot.snapshotJson)))
      .digest("hex"),
  };
}

// 递归排序对象键后序列化，保证同一语义的快照得到稳定签名。
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
