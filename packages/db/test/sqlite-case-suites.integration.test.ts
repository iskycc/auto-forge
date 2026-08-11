import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "path";

import { afterEach, describe, expect, it } from "vitest";

import { RunBatchSchedulingService, type JarObjectStorePort } from "@autoforge/application";
import { defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";

import { createSqliteDatabase } from "../src/database";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { SqliteRunnerRepository } from "../src/sqlite-runner";

const timestamp = "2026-08-09T00:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite case suite lifecycle", () => {
  it("records version snapshots for updates and case changes, and enforces revisions", async () => {
    const { handle, suites } = await fixture();
    try {
      insertUser(handle);
      await suites.create({ id: "suite-1", name: "Smoke", createdAt: timestamp });
      await suites.addCases({
        suiteId: "suite-1",
        items: [{ id: "item-1", caseDefinitionId: "case-1" }],
        versionId: "sv-2",
        actorId: "actor-1",
        updatedAt: timestamp,
      });

      const updated = await suites.updateSuite({
        suiteId: "suite-1",
        expectedRevision: 2,
        versionId: "sv-3",
        changeReason: "suite.update:rename+policy",
        actorId: "actor-1",
        updatedAt: "2026-08-09T00:02:00.000Z",
        name: "Smoke Nightly",
        policy: {
          ...defaultCaseSuiteExecutionPolicy,
          concurrency: 8,
          runnerLabels: ["gpu"],
          parameters: { SUITE: "nightly" },
          artifactPatterns: ["reports/**", "logs/*.txt"],
        },
      });
      expect(updated).toMatchObject({
        name: "Smoke Nightly",
        version: 3,
        revision: 3,
        status: "active",
        enabled: true,
        updatedBy: "actor-1",
      });
      expect(updated.policy).toMatchObject({
        concurrency: 8,
        runnerLabels: ["gpu"],
        parameters: { SUITE: "nightly" },
        artifactPatterns: ["reports/**", "logs/*.txt"],
      });

      const snapshots = suiteVersionRows(handle, "suite-1");
      expect(snapshots.map((row) => [row.version, row.change_reason])).toEqual([
        [2, "suite.cases.add"],
        [3, "suite.update:rename+policy"],
      ]);
      const latest = JSON.parse(snapshots[1]!.snapshot_json) as {
        name: string;
        policy: { concurrency: number };
        caseDefinitionIds: string[];
      };
      expect(latest.name).toBe("Smoke Nightly");
      expect(latest.policy.concurrency).toBe(8);
      expect(latest.caseDefinitionIds).toEqual(["case-1"]);

      await expect(
        suites.updateSuite({
          suiteId: "suite-1",
          expectedRevision: 2,
          versionId: "sv-stale",
          changeReason: "suite.update:rename",
          updatedAt: timestamp,
          name: "stale write",
        }),
      ).rejects.toMatchObject({ code: "CASE_SUITE_REVISION_CONFLICT" });
      await expect(
        suites.updateSuite({
          suiteId: "suite-missing",
          expectedRevision: 1,
          versionId: "sv-missing",
          changeReason: "suite.update:rename",
          updatedAt: timestamp,
          name: "missing",
        }),
      ).rejects.toMatchObject({ code: "CASE_SUITE_NOT_FOUND" });
    } finally {
      handle.close();
    }
  });

  it("archives, disables and copies suites with inherited policy", async () => {
    const { handle, suites } = await fixture();
    try {
      await suites.create({
        id: "suite-1",
        name: "Smoke",
        description: "base",
        createdAt: timestamp,
      });
      await suites.addCases({
        suiteId: "suite-1",
        items: [{ id: "item-1", caseDefinitionId: "case-1" }],
        versionId: "sv-2",
        updatedAt: timestamp,
      });
      const archived = await suites.updateSuite({
        suiteId: "suite-1",
        expectedRevision: 2,
        versionId: "sv-3",
        changeReason: "suite.update:archive+disable",
        updatedAt: timestamp,
        archived: true,
        enabled: false,
      });
      expect(archived).toMatchObject({ status: "archived", enabled: false });

      const copied = await suites.copySuite({
        id: "suite-copy",
        name: "Smoke 副本",
        description: "base",
        policy: { ...defaultCaseSuiteExecutionPolicy, runnerLabels: ["gpu"] },
        items: [{ id: "item-copy-1", caseDefinitionId: "case-1" }],
        versionId: "sv-copy-1",
        createdAt: "2026-08-09T00:03:00.000Z",
      });
      expect(copied).toMatchObject({
        id: "suite-copy",
        name: "Smoke 副本",
        version: 1,
        revision: 1,
        status: "active",
        enabled: true,
        caseCount: 1,
      });
      expect(copied.policy.runnerLabels).toEqual(["gpu"]);
      expect(copied.items[0]?.caseDefinition.id).toBe("case-1");
      const snapshots = suiteVersionRows(handle, "suite-copy");
      expect(snapshots.map((row) => [row.version, row.change_reason])).toEqual([[1, "suite.copy"]]);
    } finally {
      handle.close();
    }
  });

  it("freezes merged suite policy on the batch and into assignment specs", async () => {
    const { handle, catalog, suites, runners, batches } = await fixture();
    try {
      await suites.create({ id: "suite-1", name: "Smoke", createdAt: timestamp });
      await suites.addCases({
        suiteId: "suite-1",
        items: [{ id: "item-1", caseDefinitionId: "case-1" }],
        versionId: "sv-2",
        updatedAt: timestamp,
      });
      await suites.updateSuite({
        suiteId: "suite-1",
        expectedRevision: 2,
        versionId: "sv-3",
        changeReason: "suite.update:policy",
        updatedAt: timestamp,
        policy: {
          ...defaultCaseSuiteExecutionPolicy,
          priority: 5,
          concurrency: 2,
          retryLimit: 3,
          queueTimeoutMs: 120_000,
          executionTimeoutMs: 600_000,
          runnerLabels: ["gpu"],
          parameters: { SUITE: "nightly" },
          artifactPatterns: ["reports/**", "logs/*.txt"],
        },
      });
      await runners.register({
        id: "runner-1",
        bootstrapTokenHash: "bootstrap-1",
        credentialHash: "credential-1",
        name: "gpu-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.0",
        protocolVersion: 1,
        labels: ["java", "testng", "gpu"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 4,
        terminalEnabled: false,
        recordedAt: timestamp,
      });
      await runners.heartbeat({
        runnerId: "runner-1",
        labels: ["java", "testng", "gpu"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 4,
        busySlots: 0,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 10,
          memoryUtilizationPercent: 20,
          loadAverage1m: 0.1,
          logicalCpuCount: 2,
          observedAt: timestamp,
        },
        recordedAt: timestamp,
      });
      const scheduler = new RunBatchSchedulingService(
        batches,
        suites,
        runners,
        { now: () => new Date(timestamp) },
        sequenceIds(),
        {
          maximumCpuUtilizationPercent: 80,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        45,
        undefined,
        { catalog, objectStore: { exists: async () => true } as unknown as JarObjectStorePort },
      );

      const batch = await scheduler.create({
        suiteId: "suite-1",
        runnerIds: ["runner-1"],
        environmentVariables: [],
      });

      expect(batch).toMatchObject({
        priority: 5,
        retryLimit: 3,
        queueTimeoutMs: 120_000,
        executionTimeoutMs: 600_000,
        policy: {
          concurrency: 2,
          runnerLabels: ["gpu"],
          artifactPatterns: ["reports/**", "logs/*.txt"],
        },
      });
      const specRow = handle.client
        .prepare("SELECT execution_spec_json FROM assignments WHERE batch_id = ?")
        .get(batch.id) as { execution_spec_json: string } | undefined;
      expect(specRow).toBeDefined();
      const spec = JSON.parse(specRow!.execution_spec_json) as {
        requiredLabels: string[];
        artifactRules: Array<{ pattern: string; mediaType: string }>;
        parameters: Record<string, string>;
        timeoutMs: number;
      };
      expect(spec.requiredLabels).toEqual(expect.arrayContaining(["java", "testng", "gpu"]));
      expect(spec.artifactRules).toEqual([
        { pattern: "reports/**", required: false, mediaType: "application/octet-stream" },
        { pattern: "logs/*.txt", required: false, mediaType: "text/plain" },
      ]);
      expect(spec.parameters).toEqual({ SUITE: "nightly", CASE: "level" });
      expect(spec.timeoutMs).toBe(600_000);
    } finally {
      handle.close();
    }
  });
});

type SuiteVersionRow = { version: number; change_reason: string; snapshot_json: string };

function suiteVersionRows(
  handle: ReturnType<typeof createSqliteDatabase>,
  suiteId: string,
): SuiteVersionRow[] {
  return handle.client
    .prepare(
      "SELECT version, change_reason, snapshot_json FROM case_suite_versions WHERE suite_id = ? ORDER BY version",
    )
    .all(suiteId) as SuiteVersionRow[];
}

function insertUser(handle: ReturnType<typeof createSqliteDatabase>): void {
  handle.client
    .prepare(
      `INSERT INTO users
       (id, username, normalized_username, display_name, source, status,
        force_password_change, failed_login_attempts, created_at, updated_at, version)
       VALUES ('actor-1', 'actor', 'actor', 'Actor', 'local', 'active', 0, 0, ?, ?, 1)`,
    )
    .run(timestamp, timestamp);
}

function sequenceIds(): { next: () => string } {
  let next = 0;
  return { next: () => `policy-${++next}` };
}

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-case-suites-"));
  temporaryDirectories.push(directory);
  const handle = createSqliteDatabase({
    databasePath: resolve(directory, "autoforge.sqlite"),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
  });
  const catalog = new SqliteCaseCatalogRepository(handle);
  await catalog.importCatalog({
    sourceId: "source-1",
    objectKey: "jars/aa/source.jar",
    displayName: "source",
    importedAt: timestamp,
    inspection: {
      schemaVersion: 1,
      fileName: "source.jar",
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
          className: "com.example.SmokeTest",
          packageName: "com.example",
          simpleName: "SmokeTest",
          enabled: true,
          classLevelTest: false,
          groups: ["smoke"],
          methods: [
            {
              methodName: "smoke",
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
    },
    cases: [
      {
        caseDefinitionId: "case-1",
        caseVersionId: "version-1",
        candidate: {
          className: "com.example.SmokeTest",
          packageName: "com.example",
          simpleName: "SmokeTest",
          enabled: true,
          classLevelTest: false,
          groups: ["smoke"],
          parameters: { CASE: "level" },
          methods: [
            {
              methodName: "smoke",
              descriptor: "()V",
              enabled: true,
              annotationSource: "method",
              groups: ["smoke"],
              dependsOnMethods: [],
              dependsOnGroups: [],
            },
          ],
        },
        methods: [{ methodId: "method-1", methodIndex: 0 }],
      },
    ],
  });
  return {
    handle,
    catalog,
    suites: new SqliteCaseSuiteRepository(handle),
    runners: new SqliteRunnerRepository(handle),
    batches: new SqliteRunBatchRepository(handle),
  };
}
