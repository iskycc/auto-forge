import type { JarImportJob, JarInspection, JobEnvelope } from "@autoforge/contracts";
import { describe, expect, it, vi } from "vitest";

import { ImportTestNgJarService } from "../src/import-testng-jar";
import type { CaseCatalogRepository, ExistingSource, JarObjectStorePort } from "../src/ports";

const inspection: JarInspection = {
  schemaVersion: 1,
  fileName: "checkout-tests.jar",
  sha256: "a".repeat(64),
  sizeBytes: 128,
  classFileCount: 1,
  testClassCount: 1,
  testMethodCount: 1,
  hasRootTestNgXml: false,
  discoveryMode: "bytecode-annotations",
  warnings: [],
  classes: [
    {
      className: "com.example.CheckoutTest",
      packageName: "com.example",
      simpleName: "CheckoutTest",
      enabled: true,
      classLevelTest: false,
      groups: ["smoke"],
      methods: [
        {
          methodName: "checkout",
          descriptor: "()V",
          enabled: true,
          annotationSource: "method",
          groups: ["smoke"],
          dependsOnMethods: [],
          dependsOnGroups: [],
        },
      ],
    },
  ],
};

describe("ImportTestNgJarService", () => {
  it("returns an existing source without writing an object", async () => {
    const existing = existingSource("source-existing");
    const objectStore = objectStoreFake();
    const service = serviceWith({
      catalog: catalogFake([existing]),
      objectStore,
    });

    const result = await service.execute({
      fileName: inspection.fileName,
      content: new Uint8Array(),
    });

    expect(result).toMatchObject({ sourceId: existing.sourceId, duplicate: true });
    expect(objectStore.putJar).not.toHaveBeenCalled();
  });

  it("removes a newly created object when the database import fails", async () => {
    const importFailure = new Error("database unavailable");
    const objectStore = objectStoreFake();
    const service = serviceWith({
      catalog: catalogFake([null, null], importFailure),
      objectStore,
    });

    await expect(
      service.execute({ fileName: inspection.fileName, content: new Uint8Array() }),
    ).rejects.toBe(importFailure);
    expect(objectStore.delete).toHaveBeenCalledWith("jars/aa/source.jar");
  });

  it("returns the winning source after a concurrent duplicate import", async () => {
    const winningSource = existingSource("source-winner");
    const objectStore = objectStoreFake();
    const service = serviceWith({
      catalog: catalogFake([null, winningSource], new Error("unique constraint")),
      objectStore,
    });

    const result = await service.execute({
      fileName: inspection.fileName,
      content: new Uint8Array(),
    });

    expect(result).toMatchObject({ sourceId: winningSource.sourceId, duplicate: true });
    expect(objectStore.delete).not.toHaveBeenCalled();
  });

  it("persists an idempotent background job before worker processing", async () => {
    const catalog = catalogFake([]);
    vi.mocked(catalog.createJarImportJob).mockImplementation(async (record) => record.job);
    const service = serviceWith({ catalog, objectStore: objectStoreFake() });

    const job = await service.enqueue({
      fileName: inspection.fileName,
      content: new Uint8Array([1, 2, 3]),
      sha256: inspection.sha256,
      idempotencyKey: `sha256:${inspection.sha256}`,
      projectId: "project-1",
      actorId: "user-1",
    });

    expect(job).toMatchObject({ status: "queued", projectId: "project-1", progressPercent: 0 });
    expect(catalog.createJarImportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `sha256:${inspection.sha256}`,
        dispatchJob: expect.objectContaining({ kind: "jar-import" }),
      }),
    );
  });

  it("updates progress and stores a worker result", async () => {
    const catalog = catalogFake([null]);
    const objectStore = objectStoreFake();
    vi.mocked(objectStore.read).mockResolvedValue(new Uint8Array([1, 2, 3]));
    const queuedJob: JarImportJob = {
      id: "job-1",
      projectId: "project-1",
      fileName: inspection.fileName,
      sha256: inspection.sha256,
      sizeBytes: 3,
      status: "queued",
      progressPercent: 0,
      requestedBy: "user-1",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    };
    vi.mocked(catalog.claimJarImportJob).mockResolvedValue({
      job: { ...queuedJob, status: "running", progressPercent: 5 },
      objectKey: "jars/aa/source.jar",
    });
    vi.mocked(catalog.getJarImportJob).mockResolvedValue({
      ...queuedJob,
      status: "running",
    });
    vi.mocked(catalog.updateJarImportJob).mockImplementation(async (input) => ({
      ...queuedJob,
      status: input.status,
      progressPercent: input.progressPercent,
      ...(input.result ? { result: input.result } : {}),
      updatedAt: input.updatedAt,
    }));
    const service = serviceWith({ catalog, objectStore });
    const envelope: JobEnvelope = {
      schemaVersion: 1,
      messageId: "message-1",
      runId: "job-1",
      attempt: 1,
      createdAt: "2026-08-09T00:00:00.000Z",
      priority: 0,
      deduplicationKey: "jar-import:job-1",
      kind: "jar-import",
      payload: { jobId: "job-1" },
    };

    await service.jobHandler()(envelope, new AbortController().signal);

    expect(catalog.importCatalog).toHaveBeenCalledOnce();
    expect(catalog.updateJarImportJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ jobId: "job-1", status: "succeeded", progressPercent: 100 }),
    );
  });
});

function serviceWith(dependencies: {
  catalog: CaseCatalogRepository;
  objectStore: JarObjectStorePort;
}): ImportTestNgJarService {
  let nextID = 0;
  return new ImportTestNgJarService({
    discovery: {
      inspect: vi.fn().mockResolvedValue(inspection),
      readSource: vi.fn(),
    },
    catalog: dependencies.catalog,
    objectStore: dependencies.objectStore,
    clock: { now: () => new Date("2026-08-09T00:00:00.000Z") },
    ids: { next: () => `id-${++nextID}` },
  });
}

function existingSource(sourceId: string): ExistingSource {
  return { sourceId, classCount: 1, methodCount: 1 };
}

function objectStoreFake(): JarObjectStorePort & {
  putJar: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    storageKind: "local",
    putJar: vi.fn().mockResolvedValue({ objectKey: "jars/aa/source.jar", created: true }),
    putObject: vi.fn(),
    putArtifact: vi.fn(),
    prepareArtifactUpload: vi.fn().mockResolvedValue({ kind: "control-plane" }),
    verifyArtifactUpload: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
    list: vi.fn(),
    read: vi.fn(),
    ready: vi.fn(),
  };
}

function catalogFake(
  sources: Array<ExistingSource | null>,
  importError?: Error,
): CaseCatalogRepository {
  const remainingSources = [...sources];
  return {
    createJarImportJob: vi.fn(),
    getJarImportJob: vi.fn(),
    claimJarImportJob: vi.fn(),
    updateJarImportJob: vi.fn(),
    requestJarImportCancellation: vi.fn(),
    retryJarImportJob: vi.fn(),
    findSourceBySha256: vi.fn(async () => remainingSources.shift() ?? null),
    importCatalog: vi.fn(async () => {
      if (importError) throw importError;
    }),
    listCases: vi.fn(),
    listLatestRunOutcomes: vi.fn(async () => []),
    findExistingCaseIds: vi.fn(),
    listRecentSources: vi.fn(),
    listSources: vi.fn(),
    getSource: vi.fn(),
    setAuthoritativeSource: vi.fn(),
    getDashboardSummary: vi.fn(),
    getCaseDefinition: vi.fn(),
    updateCaseDefinition: vi.fn(),
    listCaseVersions: vi.fn(),
    getCaseVersion: vi.fn(),
    restoreCaseVersion: vi.fn(),
    getAuthoritativeSource: vi.fn(),
    listSourceCaseSnapshots: vi.fn(),
    createSourceComparison: vi.fn(),
    getSourceComparison: vi.fn(),
    promoteAuthoritativeSource: vi.fn(),
    updateSourceLifecycle: vi.fn(),
    countSourceReferences: vi.fn(),
    enqueueSourceDeletion: vi.fn(),
    getCleanupJob: vi.fn(),
    completeCleanupJob: vi.fn(),
  };
}
