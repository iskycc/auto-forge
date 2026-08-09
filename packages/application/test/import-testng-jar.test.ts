import type { JarInspection } from "@autoforge/contracts";
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
});

function serviceWith(dependencies: {
  catalog: CaseCatalogRepository;
  objectStore: JarObjectStorePort;
}): ImportTestNgJarService {
  let nextID = 0;
  return new ImportTestNgJarService({
    discovery: { inspect: vi.fn().mockResolvedValue(inspection) },
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
    delete: vi.fn().mockResolvedValue(undefined),
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
    findSourceBySha256: vi.fn(async () => remainingSources.shift() ?? null),
    importCatalog: vi.fn(async () => {
      if (importError) throw importError;
    }),
    listCases: vi.fn(),
    findExistingCaseIds: vi.fn(),
    listRecentSources: vi.fn(),
    listSources: vi.fn(),
    getSource: vi.fn(),
    setAuthoritativeSource: vi.fn(),
    getDashboardSummary: vi.fn(),
  };
}
