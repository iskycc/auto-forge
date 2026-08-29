import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "path";

import { afterEach, describe, expect, it } from "vitest";

import { RunBatchSchedulingService, type JarObjectStorePort } from "@autoforge/application";
import { DEFAULT_PROJECT_ID, defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";

import { createSqliteDatabase } from "../src/database";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
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
  it("filters tasks by their bound project version before applying the result limit", async () => {
    const { handle, suites } = await fixture();
    try {
      for (const [id, projectVersionId, updatedAt] of [
        ["suite-v1-old", "version-1", "2026-08-09T00:00:00.000Z"],
        ["suite-v2", "version-2", "2026-08-09T00:01:00.000Z"],
        ["suite-v1-new", "version-1", "2026-08-09T00:02:00.000Z"],
      ] as const) {
        await suites.create({
          id,
          name: id,
          policy: { ...defaultCaseSuiteExecutionPolicy, projectVersionId },
          createdAt: updatedAt,
        });
      }

      await expect(suites.list(1, [DEFAULT_PROJECT_ID], "version-1")).resolves.toMatchObject([
        { id: "suite-v1-new", policy: { projectVersionId: "version-1" } },
      ]);
      await expect(suites.list(10, [DEFAULT_PROJECT_ID], "version-2")).resolves.toMatchObject([
        { id: "suite-v2" },
      ]);
    } finally {
      handle.close();
    }
  });

  it("keeps Jenkins credentials outside policy JSON and removes them with deleted rules", async () => {
    const { handle, suites } = await fixture();
    try {
      await suites.create({ id: "suite-recovery", name: "Recovery", createdAt: timestamp });
      const recoveryPolicy = {
        ...defaultCaseSuiteExecutionPolicy,
        retryMode: "round" as const,
        retryLimit: 1,
        roundRecoveryRules: [
          {
            id: "recovery-1",
            afterRound: 1,
            jenkinsJobUrl: "https://jenkins.internal/job/reset/",
            waitMinutes: 5,
            apiKeyConfigured: true,
          },
        ],
      };
      await suites.updateSuite({
        suiteId: "suite-recovery",
        expectedRevision: 1,
        versionId: "sv-recovery-2",
        changeReason: "suite.update:policy",
        updatedAt: timestamp,
        policy: recoveryPolicy,
        roundRecoveryCredentialUpserts: { "recovery-1": "encrypted-credential" },
      });
      await expect(
        suites.getRoundRecoveryCredentials("suite-recovery", ["recovery-1"]),
      ).resolves.toEqual({ "recovery-1": "encrypted-credential" });

      await suites.updateSuite({
        suiteId: "suite-recovery",
        expectedRevision: 2,
        versionId: "sv-recovery-3",
        changeReason: "suite.update:policy",
        updatedAt: timestamp,
        policy: { ...defaultCaseSuiteExecutionPolicy },
      });
      await expect(
        suites.getRoundRecoveryCredentials("suite-recovery", ["recovery-1"]),
      ).resolves.toEqual({});
    } finally {
      handle.close();
    }
  });

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
      expect((await suites.get(copied.id))?.items[0]?.caseDefinition.id).toBe("case-1");
      const snapshots = suiteVersionRows(handle, "suite-copy");
      expect(snapshots.map((row) => [row.version, row.change_reason])).toEqual([[1, "suite.copy"]]);
    } finally {
      handle.close();
    }
  });

  it("freezes merged suite policy on the batch and into assignment specs", async () => {
    const { handle, catalog, suites, runners, batches } = await fixture();
    try {
      handle.client
        .prepare(
          `INSERT INTO project_runtime_assets
           (id, project_id, kind, source_type, file_name, url, object_key, sha256, size_bytes,
            archive_format, created_by, created_at)
           VALUES (?, ?, ?, 'url', ?, ?, NULL, ?, ?, 'zip', NULL, ?)`,
        )
        .run(
          "jdk-runtime",
          DEFAULT_PROJECT_ID,
          "jdk",
          "jdk.zip",
          "http://10.0.0.8/jdk.zip",
          "a".repeat(64),
          1024,
          timestamp,
        );
      handle.client
        .prepare(
          `INSERT INTO project_runtime_assets
           (id, project_id, kind, source_type, file_name, url, object_key, sha256, size_bytes,
            archive_format, created_by, created_at)
           VALUES (?, ?, ?, 'url', ?, ?, NULL, ?, ?, 'zip', NULL, ?)`,
        )
        .run(
          "jar-runtime",
          DEFAULT_PROJECT_ID,
          "jar-bundle",
          "jars.zip",
          "http://10.0.0.8/jars.zip",
          "b".repeat(64),
          2048,
          timestamp,
        );
      handle.client
        .prepare(
          `INSERT INTO project_adapter_configurations
           (project_id, suite_name, test_name, environment_address, jdk_asset_id,
            jar_bundle_asset_id, revision, updated_by, updated_at)
           VALUES (?, 'legacy-project-suite', 'legacy-project-test', '192.0.2.1', ?, ?, 1, NULL, ?)`,
        )
        .run(DEFAULT_PROJECT_ID, "jdk-runtime", "jar-runtime", timestamp);
      await new SqliteProjectStructureRepository(handle).updateAdapterConfiguration({
        projectId: DEFAULT_PROJECT_ID,
        projectVersionId: "project-version-1",
        jdkAssetId: "jdk-runtime",
        jarBundleAssetId: "jar-runtime",
        expectedRevision: 0,
        updatedAt: timestamp,
      });
      await suites.create({ id: "suite-1", name: "Smoke", createdAt: timestamp });
      await suites.addCases({
        suiteId: "suite-1",
        items: [
          { id: "item-1", caseDefinitionId: "case-1" },
          { id: "item-2", caseDefinitionId: "case-2" },
        ],
        versionId: "sv-2",
        updatedAt: timestamp,
      });
      handle.client
        .prepare(
          `INSERT INTO ddt_cases
           (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized,
            sr_num, sr_num_normalized, case_kind, data_json, execution_case_definition_id,
            source_name, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'standard', ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          "ddt-1",
          DEFAULT_PROJECT_ID,
          "project-version-1",
          "stage-1",
          "ORDER-1",
          "order-1",
          "SR-ORDER",
          "sr-order",
          JSON.stringify({ CaseID: "ORDER-1", srNum: "SR-ORDER", amount: 100 }),
          "case-1",
          "orders.xlsx",
          timestamp,
          timestamp,
        );
      await suites.addDdtCases({
        suiteId: "suite-1",
        items: [{ id: "ddt-item-1", ddtCaseId: "ddt-1" }],
        versionId: "sv-ddt-3",
        updatedAt: timestamp,
      });
      await suites.updateSuite({
        suiteId: "suite-1",
        expectedRevision: 3,
        versionId: "sv-4",
        changeReason: "suite.update:policy",
        updatedAt: timestamp,
        policy: {
          ...defaultCaseSuiteExecutionPolicy,
          adapter: {
            enabled: true,
            suiteName: "task-suite",
            testName: "task-test",
            environmentAddresses: ["10.0.0.9", "10.0.0.10", "10.0.0.11"],
          },
          priority: 5,
          concurrency: 3,
          retryLimit: 3,
          projectVersionId: "project-version-1",
          queueTimeoutMs: 120_000,
          runnerIds: ["runner-1"],
          runnerLabels: ["gpu"],
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
        capabilities: [
          "executor:testng-v1",
          "adapter:cotest-testng-v1",
          "runtime:project-assets-v1",
          "isolation:cgroup-v2",
          "java:21.0.8",
          "testng:7.11.0",
        ],
        maxConcurrency: 4,
        terminalEnabled: false,
        recordedAt: timestamp,
      });
      await runners.heartbeat({
        runnerId: "runner-1",
        labels: ["java", "testng", "gpu"],
        capabilities: [
          "executor:testng-v1",
          "adapter:cotest-testng-v1",
          "runtime:project-assets-v1",
          "isolation:cgroup-v2",
          "java:21.0.8",
          "testng:7.11.0",
        ],
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
        { catalog, objectStore: { exists: async () => true } as unknown as JarObjectStorePort },
        128,
        5,
        new SqliteProjectStructureRepository(handle),
      );

      const preflight = await scheduler.preflight({ suiteId: "suite-1" });
      expect(preflight.blockers).toEqual([]);
      const batch = await scheduler.create({ suiteId: "suite-1" });

      expect(batch).toMatchObject({
        priority: 5,
        retryLimit: 3,
        queueTimeoutMs: 120_000,
        executionTimeoutMs: 600_000,
        policy: {
          concurrency: 3,
          runnerLabels: ["gpu"],
          artifactPatterns: ["reports/**", "logs/*.txt"],
        },
      });
      const specRows = handle.client
        .prepare(
          "SELECT execution_spec_json FROM assignments WHERE batch_id = ? ORDER BY execution_run_id",
        )
        .all(batch.id) as Array<{ execution_spec_json: string }>;
      expect(specRows).toHaveLength(3);
      const specs = specRows.map((row) => JSON.parse(row.execution_spec_json)) as Array<{
        requiredLabels: string[];
        requiredCapabilities: string[];
        artifactRules: Array<{ pattern: string; mediaType: string }>;
        parameters: Record<string, string>;
        adapter: {
          suiteName: string;
          testName: string;
          environmentAddress: string;
          caseTimeoutSeconds: number;
        };
        inputs: Array<{
          inputId: string;
          kind: string;
          targetPath: string;
          mediaType: string;
          sizeBytes: number;
          sha256: string;
          downloadUrl?: string;
        }>;
        timeoutMs: number;
      }>;
      const spec = specs[0]!;
      expect(spec.requiredLabels).toEqual(expect.arrayContaining(["java", "testng", "gpu"]));
      expect(spec.artifactRules).toEqual([
        { pattern: "reports/**", required: false, mediaType: "application/octet-stream" },
        { pattern: "logs/*.txt", required: false, mediaType: "text/plain" },
      ]);
      expect(spec.parameters).toEqual({ CASE: "level" });
      expect(spec.adapter).toEqual({
        suiteName: "task-suite",
        testName: "task-test",
        environmentAddress: "10.0.0.9",
        caseTimeoutSeconds: 600,
      });
      expect(specs.map((candidate) => candidate.adapter.environmentAddress)).toEqual([
        "10.0.0.9",
        "10.0.0.10",
        "10.0.0.11",
      ]);
      const ddtSpec = specs.find((candidate) =>
        candidate.inputs.some((input) => input.kind === "class-data"),
      );
      expect(ddtSpec).toBeDefined();
      expect(ddtSpec?.inputs.find((input) => input.kind === "class-data")).toMatchObject({
        inputId: expect.stringMatching(/^class-data-/),
        targetPath: expect.stringMatching(/^inputs\/class-data\/.+\.json$/),
        mediaType: "application/json",
      });
      const storedDdtRun = handle.client
        .prepare(
          `SELECT case_type, ddt_sr_num, class_data_json, class_data_size_bytes,
                  class_data_sha256, execution_case_definition_id
           FROM execution_runs WHERE case_type = 'ddt' LIMIT 1`,
        )
        .get() as {
        case_type: string;
        ddt_sr_num: string;
        class_data_json: string;
        class_data_size_bytes: number;
        class_data_sha256: string;
        execution_case_definition_id: string;
      };
      expect(storedDdtRun).toMatchObject({
        case_type: "ddt",
        ddt_sr_num: "SR-ORDER",
        execution_case_definition_id: "case-1",
      });
      expect(JSON.parse(storedDdtRun.class_data_json)).toEqual({
        CaseID: "ORDER-1",
        srNum: "SR-ORDER",
        amount: 100,
      });
      expect(Buffer.byteLength(storedDdtRun.class_data_json)).toBe(
        storedDdtRun.class_data_size_bytes,
      );
      expect(spec.requiredCapabilities).toEqual(
        expect.arrayContaining(["adapter:cotest-testng-v1", "runtime:project-assets-v1"]),
      );
      expect(spec.inputs.map((input) => input.kind)).toEqual([
        "test-jar",
        "jdk-archive",
        "jar-bundle",
      ]);
      expect(spec.inputs[1]?.downloadUrl).toBe("http://10.0.0.8/jdk.zip");
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
  await new SqliteProjectStructureRepository(handle).createVersion({
    id: "project-version-1",
    projectId: DEFAULT_PROJECT_ID,
    name: "V1",
    normalizedName: "v1",
    recordedAt: timestamp,
  });
  await new SqliteProjectStructureRepository(handle).createStage({
    id: "stage-1",
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: "project-version-1",
    name: "System Test",
    normalizedName: "system test",
    description: "",
    recordedAt: timestamp,
  });
  await catalog.importCatalog({
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: "project-version-1",
    testStageId: "stage-1",
    sourceId: "source-1",
    objectKey: "jars/aa/source.jar",
    displayName: "source",
    importedAt: timestamp,
    inspection: {
      schemaVersion: 1,
      fileName: "source.jar",
      sha256: "a".repeat(64),
      sizeBytes: 128,
      classFileCount: 2,
      testClassCount: 2,
      testMethodCount: 2,
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
        {
          className: "com.example.SecondTest",
          packageName: "com.example",
          simpleName: "SecondTest",
          enabled: true,
          classLevelTest: false,
          groups: ["smoke"],
          methods: [
            {
              methodName: "second",
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
      {
        caseDefinitionId: "case-2",
        caseVersionId: "version-2",
        candidate: {
          className: "com.example.SecondTest",
          packageName: "com.example",
          simpleName: "SecondTest",
          enabled: true,
          classLevelTest: false,
          groups: ["smoke"],
          parameters: { CASE: "second" },
          methods: [
            {
              methodName: "second",
              descriptor: "()V",
              enabled: true,
              annotationSource: "method",
              groups: ["smoke"],
              dependsOnMethods: [],
              dependsOnGroups: [],
            },
          ],
        },
        methods: [{ methodId: "method-2", methodIndex: 0 }],
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
