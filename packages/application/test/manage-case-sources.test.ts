import { describe, expect, it, vi } from "vitest";

import type { CaseSource, CaseSourceComparison, CleanupJob } from "@autoforge/domain";
import type { JarInspection, JobEnvelope } from "@autoforge/contracts";

import { CaseSourceService } from "../src/manage-case-sources";
import type { CaseCatalogRepository, JarObjectStorePort, JobQueuePort } from "../src/ports";

const timestamp = "2026-08-09T00:00:00.000Z";

function sourceRecord(overrides: Partial<CaseSource> = {}): CaseSource {
  return {
    id: "source-1",
    projectId: "project-1",
    displayName: "candidate.jar",
    originalFileName: "candidate.jar",
    objectKey: "jars/bb/candidate.jar",
    sha256: "b".repeat(64),
    sizeBytes: 256,
    classCount: 2,
    methodCount: 2,
    status: "ready",
    warningCount: 0,
    authoritative: false,
    lifecycleStatus: "active",
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function catalogFake(source: CaseSource | null) {
  return {
    getSource: vi.fn(async () => (source ? { source, inspection: {} as JarInspection } : null)),
    getAuthoritativeSource: vi.fn(async () => null as CaseSource | null),
    listSourceCaseSnapshots: vi.fn<
      (
        sourceId: string,
      ) => Promise<Array<{ caseDefinitionId: string; className: string; snapshotJson: string }>>
    >(async () => []),
    createSourceComparison: vi.fn(async (record: unknown) => record),
    getSourceComparison: vi.fn(async (): Promise<CaseSourceComparison | null> => null),
    promoteAuthoritativeSource: vi.fn(async () => sourceRecord()),
    updateSourceLifecycle: vi.fn(async () => sourceRecord()),
    countSourceReferences: vi.fn(async () => ({
      caseDefinitions: 0,
      caseVersions: 0,
      executionRuns: 0,
    })),
    detachSourceForCleanup: vi.fn(async () => 0),
    enqueueSourceDeletion: vi.fn(async () => sourceRecord({ lifecycleStatus: "deleting" })),
    getCleanupJob: vi.fn(async () => null as CleanupJob | null),
    completeCleanupJob: vi.fn(async () => undefined),
  };
}

function objectStoreFake() {
  return {
    storageKind: "local" as const,
    delete: vi.fn(async () => undefined),
  } as unknown as JarObjectStorePort & { delete: ReturnType<typeof vi.fn> };
}

function queueFake() {
  return { publish: vi.fn(async () => "published" as const) } as unknown as JobQueuePort & {
    publish: ReturnType<typeof vi.fn>;
  };
}

function serviceWith(
  catalog: ReturnType<typeof catalogFake>,
  objectStore = objectStoreFake(),
  queue?: JobQueuePort & { publish: ReturnType<typeof vi.fn> },
) {
  let generated = 0;
  const service = new CaseSourceService(
    catalog as unknown as CaseCatalogRepository,
    objectStore,
    { now: () => new Date(timestamp) },
    { next: () => `generated-${++generated}` },
    queue,
  );
  return { service, objectStore };
}

function cleanupJobRecord(overrides: Partial<CleanupJob> = {}): CleanupJob {
  return {
    id: "cleanup-1",
    category: "case-source",
    resourceType: "case-source",
    resourceId: "source-1",
    objectKey: "jars/bb/candidate.jar",
    status: "pending",
    attemptCount: 0,
    availableAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function cleanupEnvelope(cleanupJobId: string): JobEnvelope {
  return {
    schemaVersion: 1,
    messageId: "message-1",
    runId: cleanupJobId,
    attempt: 1,
    createdAt: timestamp,
    priority: 0,
    deduplicationKey: `object-cleanup:${cleanupJobId}`,
    kind: "object-cleanup",
    payload: { cleanupJobId },
  };
}

describe("case source comparison", () => {
  it("rejects comparison for missing, not-ready or already authoritative sources", async () => {
    const missing = serviceWith(catalogFake(null));
    await expect(missing.service.compareSources("source-1")).rejects.toMatchObject({
      code: "CASE_SOURCE_NOT_FOUND",
    });

    const failed = serviceWith(catalogFake(sourceRecord({ status: "failed" })));
    await expect(failed.service.compareSources("source-1")).rejects.toMatchObject({
      code: "CASE_SOURCE_NOT_READY",
    });

    const authoritative = serviceWith(catalogFake(sourceRecord({ authoritative: true })));
    await expect(authoritative.service.compareSources("source-1")).rejects.toMatchObject({
      code: "CASE_SOURCE_ALREADY_AUTHORITATIVE",
    });
  });

  it("diffs snapshots by canonicalized content signature and records the comparison", async () => {
    const candidate = sourceRecord();
    const catalog = catalogFake(candidate);
    catalog.getAuthoritativeSource.mockResolvedValue(
      sourceRecord({ id: "source-current", authoritative: true }),
    );
    catalog.listSourceCaseSnapshots.mockImplementation(async (sourceId: string) =>
      sourceId === "source-current"
        ? [
            {
              caseDefinitionId: "case-kept",
              className: "com.example.Kept",
              snapshotJson: JSON.stringify({ a: 1, b: 2 }),
            },
            {
              caseDefinitionId: "case-removed",
              className: "com.example.Removed",
              snapshotJson: JSON.stringify({ gone: true }),
            },
          ]
        : [
            {
              caseDefinitionId: "case-changed",
              className: "com.example.Kept",
              snapshotJson: JSON.stringify({ a: 1, b: 3 }),
            },
            {
              caseDefinitionId: "case-added",
              className: "com.example.Added",
              snapshotJson: JSON.stringify({ fresh: true }),
            },
          ],
    );
    const { service } = serviceWith(catalog);

    await service.compareSources("source-1", "actor-1");

    expect(catalog.createSourceComparison).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "generated-1",
        projectId: "project-1",
        currentSourceId: "source-current",
        candidateSourceId: "source-1",
        added: [
          expect.objectContaining({
            className: "com.example.Added",
            caseDefinitionId: "case-added",
          }),
        ],
        changed: [
          expect.objectContaining({
            className: "com.example.Kept",
            caseDefinitionId: "case-changed",
          }),
        ],
        removed: [expect.objectContaining({ className: "com.example.Removed" })],
        conflicts: [],
        truncated: false,
        createdBy: "actor-1",
        createdAt: timestamp,
      }),
    );
  });

  it("treats key-reordered snapshots as unchanged", async () => {
    const catalog = catalogFake(sourceRecord());
    catalog.getAuthoritativeSource.mockResolvedValue(
      sourceRecord({ id: "source-current", authoritative: true }),
    );
    catalog.listSourceCaseSnapshots.mockImplementation(async (sourceId: string) =>
      sourceId === "source-current"
        ? [
            {
              caseDefinitionId: "case-1",
              className: "com.example.Same",
              snapshotJson: '{"a":1,"b":[1,2],"c":{"x":true}}',
            },
          ]
        : [
            {
              caseDefinitionId: "case-1",
              className: "com.example.Same",
              snapshotJson: '{"c":{"x":true},"b":[1,2],"a":1}',
            },
          ],
    );
    const { service } = serviceWith(catalog);

    await service.compareSources("source-1");

    expect(catalog.createSourceComparison).toHaveBeenCalledWith(
      expect.objectContaining({ added: [], changed: [], removed: [], conflicts: [] }),
    );
  });

  it("marks every candidate case as added when no authoritative source exists", async () => {
    const catalog = catalogFake(sourceRecord());
    catalog.listSourceCaseSnapshots.mockResolvedValue([
      {
        caseDefinitionId: "case-1",
        className: "com.example.Only",
        snapshotJson: JSON.stringify({ only: true }),
      },
    ]);
    const { service } = serviceWith(catalog);

    await service.compareSources("source-1");

    expect(catalog.createSourceComparison).toHaveBeenCalledWith(
      expect.objectContaining({
        added: [expect.objectContaining({ className: "com.example.Only" })],
      }),
    );
    const record = catalog.createSourceComparison.mock.calls[0]?.[0] as {
      currentSourceId?: string;
    };
    expect(record.currentSourceId).toBeUndefined();
  });
});

describe("case source sync confirmation", () => {
  const comparison = {
    id: "comparison-1",
    projectId: "project-1",
    currentSourceId: "source-current",
    candidateSourceId: "source-1",
    added: [],
    changed: [],
    removed: [],
    conflicts: [],
    truncated: false,
    createdAt: timestamp,
  };

  it("rejects unknown comparisons and mismatched candidates", async () => {
    const unknown = serviceWith(catalogFake(sourceRecord()));
    await expect(
      unknown.service.confirmSync("source-1", { comparisonId: "missing", expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "CASE_SOURCE_COMPARISON_NOT_FOUND" });

    const catalog = catalogFake(sourceRecord());
    catalog.getSourceComparison.mockResolvedValue({ ...comparison, candidateSourceId: "other" });
    const { service } = serviceWith(catalog);
    await expect(
      service.confirmSync("source-1", { comparisonId: "comparison-1", expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "CASE_SOURCE_COMPARISON_MISMATCH" });
  });

  it("rejects when the authoritative source changed after the comparison", async () => {
    const catalog = catalogFake(sourceRecord());
    catalog.getSourceComparison.mockResolvedValue(comparison);
    catalog.getAuthoritativeSource.mockResolvedValue(
      sourceRecord({ id: "source-other", authoritative: true }),
    );
    const { service } = serviceWith(catalog);

    await expect(
      service.confirmSync("source-1", { comparisonId: "comparison-1", expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "CASE_SOURCE_SYNC_STALE" });
    expect(catalog.promoteAuthoritativeSource).not.toHaveBeenCalled();
  });

  it("promotes the candidate with the expected revision", async () => {
    const catalog = catalogFake(sourceRecord({ revision: 4 }));
    catalog.getSourceComparison.mockResolvedValue(comparison);
    catalog.getAuthoritativeSource.mockResolvedValue(
      sourceRecord({ id: "source-current", authoritative: true }),
    );
    const { service } = serviceWith(catalog);

    await service.confirmSync("source-1", { comparisonId: "comparison-1", expectedRevision: 4 });

    expect(catalog.promoteAuthoritativeSource).toHaveBeenCalledWith({
      sourceId: "source-1",
      expectedRevision: 4,
      updatedAt: timestamp,
      versionMerges: [],
    });
  });

  it("creates a new immutable version for each unambiguous matching class", async () => {
    const catalog = catalogFake(sourceRecord({ revision: 4 }));
    catalog.getSourceComparison.mockResolvedValue(comparison);
    catalog.getAuthoritativeSource.mockResolvedValue(
      sourceRecord({ id: "source-current", authoritative: true }),
    );
    const snapshot = {
      className: "com.example.SyncTest",
      packageName: "com.example",
      simpleName: "SyncTest",
      enabled: true,
      classLevelTest: false,
      groups: ["nightly"],
      methods: [
        {
          methodName: "runs",
          descriptor: "()V",
          enabled: true,
          annotationSource: "method" as const,
          groups: ["nightly"],
          dependsOnMethods: [],
          dependsOnGroups: [],
        },
      ],
    };
    catalog.listSourceCaseSnapshots.mockImplementation(async (sourceId: string) => [
      {
        caseDefinitionId: sourceId === "source-current" ? "case-current" : "case-candidate",
        className: snapshot.className,
        snapshotJson: JSON.stringify(snapshot),
      },
    ]);
    const { service } = serviceWith(catalog);

    await service.confirmSync(
      "source-1",
      { comparisonId: "comparison-1", expectedRevision: 4 },
      undefined,
      "actor-1",
    );

    expect(catalog.promoteAuthoritativeSource).toHaveBeenCalledWith({
      sourceId: "source-1",
      expectedRevision: 4,
      updatedAt: timestamp,
      actorId: "actor-1",
      versionMerges: [
        {
          currentCaseDefinitionId: "case-current",
          candidateCaseDefinitionId: "case-candidate",
          caseVersionId: "generated-1",
          snapshot,
          methodIds: ["generated-2"],
        },
      ],
    });
  });
});

describe("case source lifecycle and deletion", () => {
  it("maps archive input to the lifecycle update", async () => {
    const catalog = catalogFake(sourceRecord({ revision: 3 }));
    const { service } = serviceWith(catalog);

    await service.updateLifecycle("source-1", { archived: true, expectedRevision: 3 });

    expect(catalog.updateSourceLifecycle).toHaveBeenCalledWith({
      sourceId: "source-1",
      expectedRevision: 3,
      lifecycleStatus: "archived",
      updatedAt: timestamp,
    });
  });

  it("guards deletion against authoritative, archived and referenced sources", async () => {
    const authoritative = serviceWith(catalogFake(sourceRecord({ authoritative: true })));
    await expect(
      authoritative.service.deleteSource("source-1", { expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "CASE_SOURCE_AUTHORITATIVE" });

    const archived = serviceWith(catalogFake(sourceRecord({ lifecycleStatus: "archived" })));
    await expect(
      archived.service.deleteSource("source-1", { expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "CASE_SOURCE_NOT_DELETABLE" });

    const referenced = catalogFake(sourceRecord());
    referenced.countSourceReferences.mockResolvedValue({
      caseDefinitions: 2,
      caseVersions: 3,
      executionRuns: 5,
    });
    const inUse = serviceWith(referenced);
    await expect(
      inUse.service.deleteSource("source-1", { expectedRevision: 1 }),
    ).rejects.toMatchObject({
      code: "CASE_SOURCE_IN_USE",
      details: { caseDefinitions: 2, caseVersions: 3, executionRuns: 5 },
    });
    expect(referenced.enqueueSourceDeletion).not.toHaveBeenCalled();
  });

  it("enqueues the deletion and publishes a deduplicated cleanup job", async () => {
    const catalog = catalogFake(sourceRecord({ revision: 2 }));
    const queue = queueFake();
    const { service } = serviceWith(catalog, objectStoreFake(), queue);

    await service.deleteSource("source-1", { expectedRevision: 2 });

    expect(catalog.enqueueSourceDeletion).toHaveBeenCalledWith({
      sourceId: "source-1",
      expectedRevision: 2,
      cleanupJobId: "generated-1",
      objectKey: "jars/bb/candidate.jar",
      availableAt: timestamp,
      updatedAt: timestamp,
    });
    expect(queue.publish).toHaveBeenCalledWith({
      schemaVersion: 1,
      messageId: "generated-2",
      runId: "generated-1",
      attempt: 1,
      createdAt: timestamp,
      priority: 0,
      deduplicationKey: "object-cleanup:generated-1",
      kind: "object-cleanup",
      payload: { cleanupJobId: "generated-1" },
    });
  });

  it("requires a queue to schedule deletion", async () => {
    const catalog = catalogFake(sourceRecord());
    const { service } = serviceWith(catalog);

    await expect(service.deleteSource("source-1", { expectedRevision: 1 })).rejects.toThrow(
      /任务队列/,
    );
    expect(catalog.enqueueSourceDeletion).not.toHaveBeenCalled();
  });
});

describe("object cleanup handler", () => {
  it("ignores missing or already completed cleanup jobs", async () => {
    const catalog = catalogFake(sourceRecord());
    const { service, objectStore } = serviceWith(catalog);
    const handler = service.objectCleanupHandler();

    await handler(cleanupEnvelope("cleanup-missing"), new AbortController().signal);
    catalog.getCleanupJob.mockResolvedValue(cleanupJobRecord({ status: "succeeded" }));
    await handler(cleanupEnvelope("cleanup-1"), new AbortController().signal);

    expect(objectStore.delete).not.toHaveBeenCalled();
    expect(catalog.completeCleanupJob).not.toHaveBeenCalled();
  });

  it("deletes the stored object and marks the job succeeded", async () => {
    const catalog = catalogFake(sourceRecord());
    catalog.getCleanupJob.mockResolvedValue(cleanupJobRecord({ attemptCount: 1 }));
    const { service, objectStore } = serviceWith(catalog);

    await service.objectCleanupHandler()(
      cleanupEnvelope("cleanup-1"),
      new AbortController().signal,
    );

    expect(objectStore.delete).toHaveBeenCalledWith("jars/bb/candidate.jar");
    expect(catalog.completeCleanupJob).toHaveBeenCalledWith({
      id: "cleanup-1",
      status: "succeeded",
      attemptCount: 2,
      finishedAt: timestamp,
    });
  });

  it("keeps a content-addressed object while another version still references it", async () => {
    const catalog = catalogFake(sourceRecord());
    catalog.getCleanupJob.mockResolvedValue(cleanupJobRecord());
    catalog.detachSourceForCleanup.mockResolvedValue(1);
    const { service, objectStore } = serviceWith(catalog);

    await service.objectCleanupHandler()(
      cleanupEnvelope("cleanup-1"),
      new AbortController().signal,
    );

    expect(catalog.detachSourceForCleanup).toHaveBeenCalledWith(
      "source-1",
      "jars/bb/candidate.jar",
    );
    expect(objectStore.delete).not.toHaveBeenCalled();
    expect(catalog.completeCleanupJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cleanup-1", status: "succeeded" }),
    );
  });

  it("retries object deletion after the source reference was already detached", async () => {
    const catalog = catalogFake(sourceRecord());
    catalog.getCleanupJob.mockResolvedValue(cleanupJobRecord());
    const objectStore = objectStoreFake();
    objectStore.delete.mockRejectedValueOnce(new Error("object store unavailable"));
    const { service } = serviceWith(catalog, objectStore);
    const handler = service.objectCleanupHandler();

    await expect(
      handler(cleanupEnvelope("cleanup-1"), new AbortController().signal),
    ).rejects.toThrow("object store unavailable");
    expect(catalog.completeCleanupJob).not.toHaveBeenCalled();

    await handler(cleanupEnvelope("cleanup-1"), new AbortController().signal);
    expect(catalog.detachSourceForCleanup).toHaveBeenCalledTimes(2);
    expect(objectStore.delete).toHaveBeenCalledTimes(2);
    expect(catalog.completeCleanupJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cleanup-1", status: "succeeded" }),
    );
  });

  it("rejects envelopes without a cleanup job id", async () => {
    const catalog = catalogFake(sourceRecord());
    const { service } = serviceWith(catalog);
    const envelope = cleanupEnvelope("");
    envelope.payload = {};

    await expect(
      service.objectCleanupHandler()(envelope, new AbortController().signal),
    ).rejects.toThrow(/payload/);
  });
});
