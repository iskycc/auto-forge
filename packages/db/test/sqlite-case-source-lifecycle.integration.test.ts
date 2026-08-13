import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CaseSourceService, type JarObjectStorePort } from "@autoforge/application";
import type { JobEnvelope, TestNgClassCandidate } from "@autoforge/contracts";

import { createSqliteDatabase } from "../src/database";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";

const timestamp = "2026-08-09T00:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite case source lifecycle", () => {
  it("compares sources, promotes the candidate and rejects stale confirmations", async () => {
    const { handle, catalog, service } = await fixture();
    try {
      const comparison = await service.compareSources("source-2");
      expect(comparison).toMatchObject({
        projectId: comparison.projectId,
        candidateSourceId: "source-2",
        currentSourceId: "source-1",
        truncated: false,
      });
      expect(comparison.added.map((entry) => entry.className)).toEqual(["com.example.Added"]);
      expect(comparison.changed.map((entry) => entry.className)).toEqual(["com.example.Kept"]);
      expect(comparison.removed.map((entry) => entry.className)).toEqual(["com.example.Removed"]);

      const stored = await catalog.getSourceComparison(comparison.id);
      expect(stored).toEqual(comparison);

      const promoted = await service.confirmSync("source-2", {
        comparisonId: comparison.id,
        expectedRevision: 1,
      });
      expect(promoted.authoritative).toBe(true);
      expect((await catalog.getAuthoritativeSource(comparison.projectId))?.id).toBe("source-2");
      const merged = await catalog.getCaseDefinition("source-1-case-1");
      expect(merged).toMatchObject({
        sourceId: "source-2",
        currentVersion: 2,
        groups: ["nightly"],
      });
      expect(await catalog.getCaseDefinition("source-2-case-1")).toBeNull();
      expect(await catalog.listCaseVersions("source-1-case-1", 10)).toMatchObject([
        { version: 2, sourceId: "source-2", changeReason: "source.sync" },
        { version: 1, sourceId: "source-1", changeReason: "source.import" },
      ]);
      expect(await catalog.countSourceReferences("source-1")).toMatchObject({
        caseDefinitions: 1,
        caseVersions: 2,
      });

      // 权威来源已翻转后，基于旧权威(source-1)的对比结果必须拒绝。
      const staleComparison = await service.compareSources("source-3");
      await catalog.setAuthoritativeSource("source-1");
      await expect(
        service.confirmSync("source-3", {
          comparisonId: staleComparison.id,
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "CASE_SOURCE_SYNC_STALE" });

      await expect(
        service.updateLifecycle("source-1", { archived: true, expectedRevision: 99 }),
      ).rejects.toMatchObject({ code: "CASE_SOURCE_REVISION_CONFLICT" });
    } finally {
      handle.close();
    }
  });

  it("deletes unreferenced sources via cleanup jobs and guards referenced ones", async () => {
    const { handle, catalog, service, objectStore, queue } = await fixture();
    try {
      await expect(service.deleteSource("source-2", { expectedRevision: 1 })).rejects.toMatchObject(
        { code: "CASE_SOURCE_IN_USE" },
      );
      // 权威来源在引用检查之前被拦截。
      await expect(service.deleteSource("source-1", { expectedRevision: 1 })).rejects.toMatchObject(
        { code: "CASE_SOURCE_AUTHORITATIVE" },
      );

      const deleting = await service.deleteSource("source-3", { expectedRevision: 1 });
      expect(deleting.lifecycleStatus).toBe("deleting");

      expect(queue.publish).toHaveBeenCalledTimes(1);
      const envelope = queue.publish.mock.calls[0]?.[0];
      expect(envelope?.kind).toBe("object-cleanup");
      const cleanupJobId = String(envelope?.payload.cleanupJobId);
      expect(envelope?.deduplicationKey).toBe(`object-cleanup:${cleanupJobId}`);

      const pending = await catalog.getCleanupJob(cleanupJobId);
      expect(pending).toMatchObject({
        status: "pending",
        objectKey: "jars/cc/unreferenced.jar",
        attemptCount: 0,
      });

      const handler = service.objectCleanupHandler();
      await handler(
        {
          schemaVersion: 1,
          messageId: "message-1",
          runId: cleanupJobId,
          attempt: 1,
          createdAt: timestamp,
          priority: 0,
          deduplicationKey: `object-cleanup:${cleanupJobId}`,
          kind: "object-cleanup",
          payload: { cleanupJobId },
        },
        new AbortController().signal,
      );
      expect(objectStore.delete).toHaveBeenCalledWith("jars/cc/unreferenced.jar");
      expect(await catalog.getCleanupJob(cleanupJobId)).toMatchObject({
        status: "succeeded",
        attemptCount: 1,
      });

      // 重复投递保持幂等，不再删除对象。
      await handler(
        {
          schemaVersion: 1,
          messageId: "message-2",
          runId: cleanupJobId,
          attempt: 1,
          createdAt: timestamp,
          priority: 0,
          deduplicationKey: `object-cleanup:${cleanupJobId}`,
          kind: "object-cleanup",
          payload: { cleanupJobId },
        },
        new AbortController().signal,
      );
      expect(objectStore.delete).toHaveBeenCalledTimes(1);
    } finally {
      handle.close();
    }
  });
});

function classCandidate(className: string, groups: string[]): TestNgClassCandidate {
  const simpleName = className.slice(className.lastIndexOf(".") + 1);
  return {
    className,
    packageName: className.slice(0, className.lastIndexOf(".")),
    simpleName,
    enabled: true,
    classLevelTest: false,
    groups,
    methods: [
      {
        methodName: "run",
        descriptor: "()V",
        enabled: true,
        annotationSource: "method",
        groups,
        dependsOnMethods: [],
        dependsOnGroups: [],
      },
    ],
  };
}

async function importSource(
  catalog: SqliteCaseCatalogRepository,
  sourceId: string,
  objectKey: string,
  sha256: string,
  classes: Array<{ name: string; groups: string[] }>,
): Promise<void> {
  await catalog.importCatalog({
    sourceId,
    objectKey,
    displayName: sourceId,
    importedAt: timestamp,
    inspection: {
      schemaVersion: 1,
      fileName: `${sourceId}.jar`,
      sha256,
      sizeBytes: 128,
      classFileCount: classes.length,
      testClassCount: classes.length,
      testMethodCount: classes.length,
      hasRootTestNgXml: false,
      discoveryMode: "bytecode-annotations",
      warnings: [],
      classes: classes.map((item) => classCandidate(item.name, item.groups)),
    },
    cases: classes.map((item, index) => ({
      caseDefinitionId: `${sourceId}-case-${index + 1}`,
      caseVersionId: `${sourceId}-version-${index + 1}`,
      candidate: classCandidate(item.name, item.groups),
      methods: [{ methodId: `${sourceId}-method-${index + 1}`, methodIndex: 0 }],
    })),
  });
}

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-case-sources-"));
  temporaryDirectories.push(directory);
  const handle = createSqliteDatabase({
    databasePath: resolve(directory, "autoforge.sqlite"),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
  });
  const catalog = new SqliteCaseCatalogRepository(handle);
  await importSource(catalog, "source-1", "jars/aa/current.jar", "a".repeat(64), [
    { name: "com.example.Kept", groups: ["smoke"] },
    { name: "com.example.Removed", groups: ["smoke"] },
  ]);
  await importSource(catalog, "source-2", "jars/bb/candidate.jar", "b".repeat(64), [
    { name: "com.example.Kept", groups: ["nightly"] },
    { name: "com.example.Added", groups: ["nightly"] },
  ]);
  await importSource(catalog, "source-3", "jars/cc/unreferenced.jar", "c".repeat(64), []);
  await catalog.setAuthoritativeSource("source-1");

  const objectStore = {
    storageKind: "local",
    delete: vi.fn(async () => undefined),
  } as unknown as JarObjectStorePort & { delete: ReturnType<typeof vi.fn> };
  const queue = {
    publish: vi.fn<(job: JobEnvelope) => Promise<"published">>(async () => "published"),
  };
  let generated = 0;
  const service = new CaseSourceService(
    catalog,
    objectStore,
    { now: () => new Date(timestamp) },
    { next: () => `generated-${++generated}` },
    queue as never,
  );
  return { handle, catalog, service, objectStore, queue };
}
