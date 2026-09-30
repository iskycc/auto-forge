import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DdtDebugService,
  DdtImportService,
  RunBatchSchedulingService,
} from "@autoforge/application";
import {
  createCaseDebugRunSchema,
  executionSpecSchema,
  type TestNgClassCandidate,
} from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID, defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";
import { LocalObjectStore } from "../../object-store/src/local-object-store";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteWriterContention } from "./sqlite-writer-contention";
import { parseDdtUpload } from "../../ddt-import/src";
import { SqliteDdtDebugRepository } from "../src/sqlite-ddt-debug";
import { PostgresDdtDebugRepository } from "../src/postgres-ddt-debug";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { PostgresDdtRepository } from "../src/postgres-ddt";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { SqliteRunnerRepository } from "../src/sqlite-runner";
import {
  PostgresCaseCatalogRepository,
  PostgresCaseSuiteRepository,
  PostgresRunnerRepository,
} from "../src/postgres-platform-repository";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} case debug execution`,
    () => {
      it("finds ordinary debug classes by mixed-case fragments within their scope", async () => {
        const fixture = await createFixture(dialect);
        try {
          const query = { ...fixture.scope, query: " FoRmAl ", limit: 50 };
          expect((await fixture.catalog.listCases(query)).items.map((item) => item.id)).toEqual([
            fixture.classId,
          ]);
          expect(
            (await fixture.catalog.listCases({ ...query, testStageId: "other-stage" })).items,
          ).toEqual([]);
        } finally {
          await fixture.close();
        }
      });
      it("isolates DDT API configuration from ordinary cases in the same Adapter batch", async () => {
        const fixture = await createFixture(dialect);
        try {
          const { scope, classId, runnerId, suites, ddt, service, now } = fixture;
          await ddt.changeExecutionClassRange({
            scope,
            executionCaseDefinitionId: classId,
            included: true,
            expectedRevision: 0,
            updatedAt: now,
          });
          await ddt.setSrExecutionClass({
            scope,
            srNum: "SR",
            executionCaseDefinitionId: classId,
            expectedRevision: 0,
            updatedAt: now,
          });
          const suiteId = randomUUID();
          await suites.create({
            id: suiteId,
            projectId: scope.projectId,
            name: "Mixed Adapter batch",
            createdAt: now,
            policy: {
              ...defaultCaseSuiteExecutionPolicy,
              projectVersionId: scope.projectVersionId,
              runnerIds: [runnerId],
              concurrency: 2,
              adapter: {
                enabled: true,
                suiteName: "Mixed",
                testName: "SIT",
                environmentAddresses: ["127.0.0.1"],
              },
            },
          });
          await suites.addCases({
            suiteId,
            items: [{ id: randomUUID(), caseDefinitionId: classId }],
            versionId: randomUUID(),
            updatedAt: now,
          });
          const ddtCase = (await ddt.getCase(scope, "DEBUG-1"))!;
          await suites.addDdtCases({
            suiteId,
            items: [{ id: randomUUID(), ddtCaseId: ddtCase.id }],
            versionId: randomUUID(),
            updatedAt: now,
          });
          const created = await service.create({ suiteId });
          const batch = (await fixture.batches.get(created.id))!;
          expect(batch.runs).toHaveLength(2);
          for (const run of batch.runs) {
            const spec = await fixture.assignmentSpec(batch.id, run.id);
            expect(spec.adapter).toBeDefined();
            if (run.caseType === "ddt") {
              expect(spec.adapter).toMatchObject({ caseId: "DEBUG-1", ddtScope: scope });
              expect(spec.requiredCapabilities).toContain("adapter:ddt-insight-url-v1");
            } else {
              expect(spec.adapter).not.toHaveProperty("ddtScope");
              expect(spec.adapter).not.toHaveProperty("caseId");
              expect(spec.requiredCapabilities).not.toContain("adapter:ddt-insight-url-v1");
            }
          }
        } finally {
          await fixture.close();
        }
      });

      it("resumes personal imports after interruption with stable receipts and observes cancellation", async () => {
        const fixture = await createFixture(dialect);
        try {
          const { imports, debugRepository, ownerId, scope, now } = fixture;
          const personalScope = { ...scope, ownerUserId: ownerId };
          const csv =
            "CaseID,srNum,account\n" +
            Array.from({ length: 70 }, (_, index) => `RECOVER-${index},SR,account-${index}`).join(
              "\n",
            );
          const job = await imports.preview(
            { ...scope, debugOwnerId: ownerId },
            [{ fileName: "recover.csv", mediaType: "text/csv", content: Buffer.from(csv) }],
            ownerId,
          );
          await imports.confirm(job.id, "error");
          const envelope = {
            schemaVersion: 1 as const,
            kind: "ddt-debug-import" as const,
            messageId: randomUUID(),
            runId: job.id,
            attempt: 1,
            createdAt: now,
            priority: 0,
            deduplicationKey: job.id,
            payload: { jobId: job.id },
          };
          const controller = new AbortController();
          const original = debugRepository.write.bind(debugRepository);
          let calls = 0;
          const interruption = vi
            .spyOn(debugRepository, "write")
            .mockImplementation(async (input) => {
              if (++calls === 2) {
                controller.abort(new Error("worker stopped"));
                throw controller.signal.reason;
              }
              return original(input);
            });
          await expect(imports.jobHandler()(envelope, controller.signal)).rejects.toThrow(
            "worker stopped",
          );
          interruption.mockRestore();
          expect((await imports.get(job.id))?.status).toBe("running");
          await imports.jobHandler()(envelope, new AbortController().signal);
          expect(await imports.get(job.id)).toMatchObject({
            status: "succeeded",
            insertedCount: 70,
          });
          expect((await debugRepository.get(personalScope, "RECOVER-0"))?.revision).toBe(1);
          const cancelled = await imports.preview(
            { ...scope, debugOwnerId: ownerId },
            [
              {
                fileName: "cancel.csv",
                mediaType: "text/csv",
                content: Buffer.from(csv.replaceAll("account-", "updated-")),
              },
            ],
            ownerId,
          );
          await imports.confirm(cancelled.id, "overwrite");
          calls = 0;
          const cancellation = vi
            .spyOn(debugRepository, "write")
            .mockImplementation(async (input) => {
              const result = await original(input);
              if (++calls === 2) await imports.cancel(cancelled.id);
              return result;
            });
          await imports.jobHandler()(
            {
              ...envelope,
              runId: cancelled.id,
              messageId: randomUUID(),
              payload: { jobId: cancelled.id },
            },
            new AbortController().signal,
          );
          cancellation.mockRestore();
          expect((await imports.get(cancelled.id))?.status).toBe("cancelled");
          expect((await debugRepository.get(personalScope, "RECOVER-69"))?.data.account).toBe(
            "account-69",
          );
        } finally {
          vi.restoreAllMocks();
          await fixture.close();
        }
      });

      it("recovers a competing writer and rejects concurrent stale edits", async () => {
        const fixture = await createFixture(dialect);
        const writer = fixture.sqlite ? new SqliteWriterContention(fixture.sqlite) : undefined;
        try {
          const repository = writer
            ? writer.wrap(fixture.debugRepository)
            : fixture.debugRepository;
          const personalScope = { ...fixture.scope, ownerUserId: fixture.ownerId };
          const item = await fixture.debugService.get(personalScope, "DEBUG-1");
          const write = {
            scope: personalScope,
            id: randomUUID(),
            caseId: item.caseId,
            data: { ...item.data, account: "changed" },
            sourceName: "test",
            now: fixture.now,
            strategy: "overwrite" as const,
            expectedRevision: item.revision,
          };
          await expect(repository.write(write)).resolves.toBe("updated");
          const results = await Promise.allSettled([
            fixture.debugRepository.write({
              ...write,
              expectedRevision: item.revision + 1,
              data: { ...item.data, account: "one" },
            }),
            fixture.debugRepository.write({
              ...write,
              expectedRevision: item.revision + 1,
              data: { ...item.data, account: "two" },
            }),
          ]);
          expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
          expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
          expect((await fixture.debugService.get(personalScope, item.caseId)).revision).toBe(
            item.revision + 2,
          );
        } finally {
          await writer?.close();
          await fixture.close();
        }
      });

      it("isolates personal values, tokens, conflict checks and replay across users without modifying formal cases", async () => {
        const fixture = await createFixture(dialect);
        try {
          const { scope, ownerId, otherOwnerId, debugService, debugRepository, imports, ddt, now } =
            fixture;
          const alice = { ...scope, ownerUserId: ownerId };
          const bob = { ...scope, ownerUserId: otherOwnerId };
          const aliceAccess = await debugService.workspace(alice);
          const bobAccess = await debugService.workspace(bob);
          expect(aliceAccess.accessKey).not.toBe(bobAccess.accessKey);
          expect(await debugService.workspace(alice)).toEqual(aliceAccess);
          await debugService.copy(bob, "DEBUG-1");
          const first = await debugService.get(alice, "DEBUG-1");
          await debugService.update(
            alice,
            "DEBUG-1",
            { ...first.data, account: "alice" },
            first.revision,
          );
          await debugService.copy(alice, "DEBUG-1");
          expect((await debugService.get(alice, "DEBUG-1")).data.account).toBe("alice");
          expect((await debugService.get(bob, "DEBUG-1")).data.account).toBeUndefined();
          await expect(
            debugService.readPublic(bob, aliceAccess.accessKey, "DEBUG-1"),
          ).rejects.toMatchObject({ code: "DDT_CASE_NOT_FOUND" });
          await expect(
            debugService.readPublic(
              { ...alice, testStageId: "wrong-stage" },
              aliceAccess.accessKey,
              "DEBUG-1",
            ),
          ).rejects.toMatchObject({ code: "DDT_CASE_NOT_FOUND" });
          await expect(
            debugService.update(alice, "DEBUG-1", first.data, first.revision),
          ).rejects.toMatchObject({ code: "DDT_CASE_CONFLICT" });
          for (const strategy of ["skip", "overwrite", "error"] as const) {
            const job = await imports.preview(
              { ...scope, debugOwnerId: ownerId },
              [
                {
                  fileName: "debug.csv",
                  mediaType: "text/csv",
                  content: Buffer.from(
                    "CaseID,srNum,account\nDEBUG-1,SR,personal-upload\nPRIVATE-2,SR,new-account\n",
                  ),
                },
              ],
              ownerId,
            );
            expect(job.debugOwnerId).toBe(ownerId);
            expect(job.validFiles).toBe(1);
            await imports.confirm(job.id, strategy);
            const envelope = {
              schemaVersion: 1 as const,
              kind: "ddt-debug-import" as const,
              messageId: randomUUID(),
              runId: job.id,
              attempt: 1,
              createdAt: now,
              priority: 0,
              deduplicationKey: job.id,
              payload: { jobId: job.id },
            };
            if (strategy === "error")
              await expect(
                imports.jobHandler()(envelope, new AbortController().signal),
              ).rejects.toMatchObject({ code: "DDT_IMPORT_CONFLICT" });
            else {
              await imports.jobHandler()(envelope, new AbortController().signal);
              const completed = await imports.get(job.id);
              expect(completed?.status).toBe("succeeded");
              await imports.jobHandler()(envelope, new AbortController().signal);
              expect(await imports.get(job.id)).toEqual(completed);
              expect((await debugService.get(alice, "DEBUG-1")).data.account).toBe(
                strategy === "skip" ? "alice" : "personal-upload",
              );
            }
            expect(
              (await imports.list(scope, undefined, 50)).items.some((item) => item.id === job.id),
            ).toBe(false);
          }
          expect((await ddt.getCase(scope, "DEBUG-1"))?.data).toEqual({
            CaseID: "DEBUG-1",
            srNum: "SR",
            amount: 12,
          });
          expect(await ddt.getCase(scope, "PRIVATE-2")).toBeNull();
          expect(await debugRepository.get(bob, "PRIVATE-2")).toBeNull();
          const page = await debugService.list(alice, { query: "", limit: 1 });
          expect(page.items).toHaveLength(1);
          const next = await debugService.list(alice, {
            query: "",
            limit: 1,
            cursor: page.nextCursor!,
          });
          expect(next.items[0]?.caseId).toBe("PRIVATE-2");
          expect(next.nextCursor).toBeUndefined();
          expect((await debugService.list(alice, { query: "%", limit: 50 })).items).toEqual([]);
          expect(
            (await debugService.list(alice, { query: " RiVaTe- ", limit: 50 })).items.map(
              (item) => item.caseId,
            ),
          ).toEqual(["PRIVATE-2"]);
        } finally {
          await fixture.close();
        }
      });

      it("persists formal TestNG and unlinked DDT debug snapshots without modifying catalog or SR mappings", async () => {
        const fixture = await createFixture(dialect);
        try {
          const { service, scope, classId, runnerId, batches, ddt, catalog } = fixture;
          for (const [kind, adapterEnabled] of [
            ["testng", false],
            ["testng", true],
            ["ddt", true],
          ] as const) {
            const batch = await service.createDebugCase(
              createCaseDebugRunSchema.parse({
                ...scope,
                kind,
                caseDefinitionId: classId,
                ...(kind === "ddt" ? { ddtCaseId: "DEBUG-1" } : {}),
                execution: {
                  runnerIds: [runnerId],
                  adapter: {
                    enabled: adapterEnabled,
                    suiteName: "Debug",
                    testName: "V1 SIT",
                    environmentAddresses: ["127.0.0.1"],
                  },
                },
              }),
              fixture.ownerId,
            );
            const persisted = await batches.get(batch.id);
            expect(persisted?.suiteName).toMatch(/^用例调试 · /);
            expect(persisted?.runs).toHaveLength(1);
            expect(persisted?.policy?.projectVersionId).toBe(scope.projectVersionId);
            const run = persisted!.runs[0]!;
            const snapshot = await batches.getRerunSnapshot(batch.id, {});
            expect(run.className).toBe("debug.FormalTest");
            expect(run.caseVersion).toBe(1);
            if (kind === "ddt") {
              expect(snapshot?.adapterRuntime?.ddtDebug).toEqual(fixture.debugAccess);
              expect(snapshot?.runs[0]).toMatchObject({
                displayName: "DEBUG-1",
                caseType: "ddt",
                executionCaseDefinitionId: classId,
                parameters: {},
              });
            } else expect(run.caseDefinitionId).toBe(classId);
            expect(run).not.toHaveProperty("classData");
            const spec = await fixture.assignmentSpec(batch.id);
            if (kind === "ddt")
              expect(spec.adapter?.ddtScope).toEqual({ ...scope, debug: fixture.debugAccess });
            else {
              if (adapterEnabled) {
                expect(spec.adapter).toBeDefined();
                expect(spec.adapter).not.toHaveProperty("ddtScope");
                expect(spec.adapter).not.toHaveProperty("caseId");
              } else expect(spec.adapter).toBeUndefined();
              expect(spec.requiredCapabilities).not.toContain("adapter:ddt-insight-url-v1");
            }
          }
          expect((await ddt.getCase(scope, "DEBUG-1"))?.executionClass).toBeUndefined();
          expect((await catalog.getCaseDefinition(classId))?.currentVersion).toBe(1);
          const targetVersion = randomUUID();
          const targetStage = randomUUID();
          const inheritedClass = randomUUID();
          await fixture.structures.createVersion({
            id: targetVersion,
            projectId: scope.projectId,
            name: targetVersion,
            normalizedName: targetVersion,
            recordedAt: fixture.now,
          });
          await fixture.structures.createStage({
            id: targetStage,
            projectId: scope.projectId,
            projectVersionId: targetVersion,
            name: "UAT",
            normalizedName: "uat",
            description: "",
            recordedAt: fixture.now,
          });
          const sourceClass = (await catalog.getCaseDefinition(classId))!;
          await catalog.inheritCaseDefinitions({
            projectId: scope.projectId,
            sourceProjectVersionId: scope.projectVersionId,
            sourceTestStageId: scope.testStageId,
            targetProjectVersionId: targetVersion,
            targetTestStageId: targetStage,
            records: [
              {
                sourceCaseDefinitionId: classId,
                targetCaseDefinitionId: inheritedClass,
                targetCaseVersionId: randomUUID(),
                methods: sourceClass.methods.map((method) => ({
                  sourceMethodId: method.id,
                  targetMethodId: randomUUID(),
                })),
              },
            ],
            inheritedAt: fixture.now,
          });
          await fixture.structures.updateAdapterConfiguration({
            projectId: scope.projectId,
            projectVersionId: targetVersion,
            jarBundleAssetId: fixture.assetId,
            expectedRevision: 0,
            updatedAt: fixture.now,
          });
          const inherited = await service.createSingleCase(inheritedClass, {
            runnerIds: [runnerId],
            adapter: {
              enabled: true,
              suiteName: "Inherited",
              testName: "UAT",
              environmentAddresses: ["127.0.0.1"],
            },
          });
          const inheritedSpec = await fixture.assignmentSpec(inherited.id);
          expect(inheritedSpec.adapter).toBeDefined();
          expect(inheritedSpec.adapter).not.toHaveProperty("ddtScope");
          expect(inheritedSpec.requiredCapabilities).not.toContain("adapter:ddt-insight-url-v1");
          await expect(
            service.createDebugCase(
              createCaseDebugRunSchema.parse({
                ...scope,
                testStageId: "wrong-stage",
                kind: "testng",
                caseDefinitionId: classId,
                execution: { runnerIds: [runnerId] },
              }),
            ),
          ).rejects.toMatchObject({ code: "CASE_DEFINITION_NOT_FOUND" });
        } finally {
          await fixture.close();
        }
      });
    },
  );
}

async function createFixture(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "case-debug-"));
  const sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: resolve(directory, "db.sqlite"),
          migrationsFolder: resolve("packages/db/drizzle/sqlite"),
        })
      : undefined;
  const postgres =
    dialect === "postgres"
      ? createPostgresDatabase({
          connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
          migrationsFolder: resolve("packages/db/drizzle/postgresql"),
        })
      : undefined;
  await postgres?.ready;
  const catalog = sqlite
    ? new SqliteCaseCatalogRepository(sqlite)
    : new PostgresCaseCatalogRepository(postgres!);
  const structures = sqlite
    ? new SqliteProjectStructureRepository(sqlite)
    : new PostgresProjectStructureRepository(postgres!);
  const ddt = sqlite ? new SqliteDdtRepository(sqlite) : new PostgresDdtRepository(postgres!);
  const runners = sqlite
    ? new SqliteRunnerRepository(sqlite)
    : new PostgresRunnerRepository(postgres!);
  const batches = sqlite
    ? new SqliteRunBatchRepository(sqlite)
    : new PostgresRunBatchRepository(postgres!);
  const suites = sqlite
    ? new SqliteCaseSuiteRepository(sqlite)
    : new PostgresCaseSuiteRepository(postgres!);
  const objectStore = new LocalObjectStore(directory);
  const scope = {
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: randomUUID(),
    testStageId: randomUUID(),
  };
  const now = "2026-09-29T00:00:00.000Z";
  await structures.createVersion({
    id: scope.projectVersionId,
    projectId: scope.projectId,
    name: scope.projectVersionId,
    normalizedName: scope.projectVersionId,
    recordedAt: now,
  });
  await structures.createStage({
    ...scope,
    id: scope.testStageId,
    name: "SIT",
    normalizedName: "sit",
    description: "",
    recordedAt: now,
  });
  const candidate: TestNgClassCandidate = {
    className: "debug.FormalTest",
    packageName: "debug",
    simpleName: "FormalTest",
    enabled: true,
    classLevelTest: false,
    groups: [],
    methods: [
      {
        methodName: "run",
        descriptor: "()V",
        enabled: true,
        annotationSource: "method",
        groups: [],
        dependsOnMethods: [],
        dependsOnGroups: [],
      },
    ],
  };
  const classId = randomUUID();
  const bytes = Buffer.from(`fixture jar ${randomUUID()}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const stored = await objectStore.putJar(scope.projectId, sha256, bytes);
  await catalog.importCatalog({
    ...scope,
    sourceId: randomUUID(),
    objectKey: stored.objectKey,
    displayName: "debug.jar",
    importedAt: now,
    inspection: {
      schemaVersion: 1,
      fileName: "debug.jar",
      sha256,
      sizeBytes: bytes.length,
      classFileCount: 1,
      testClassCount: 1,
      testMethodCount: 1,
      hasRootTestNgXml: false,
      discoveryMode: "bytecode-annotations",
      classes: [candidate],
      warnings: [],
    },
    cases: [
      {
        caseDefinitionId: classId,
        caseVersionId: randomUUID(),
        candidate,
        methods: [{ methodId: randomUUID(), methodIndex: 0 }],
      },
    ],
  });
  const asset = await structures.createRuntimeAsset({
    id: randomUUID(),
    projectId: scope.projectId,
    kind: "jar-bundle",
    sourceType: "upload",
    fileName: "runtime.zip",
    objectKey: stored.objectKey,
    sha256,
    sizeBytes: bytes.length,
    archiveFormat: "zip",
    createdAt: now,
  });
  await structures.updateAdapterConfiguration({
    projectId: scope.projectId,
    projectVersionId: scope.projectVersionId,
    jarBundleAssetId: asset.id,
    expectedRevision: 0,
    updatedAt: now,
  });
  const insert = `INSERT INTO ddt_cases (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized, sr_num, sr_num_normalized, case_kind, data_json, source_name, created_at, updated_at) VALUES (?, ?, ?, ?, 'DEBUG-1', 'debug-1', 'SR', 'sr', 'standard', ?, 'debug.csv', ?, ?)`;
  const parameters = [
    randomUUID(),
    scope.projectId,
    scope.projectVersionId,
    scope.testStageId,
    JSON.stringify({ CaseID: "DEBUG-1", srNum: "SR", amount: 12 }),
    now,
    now,
  ];
  if (sqlite) sqlite.client.prepare(insert).run(...parameters);
  else {
    let index = 0;
    await postgres!.pool.query(
      insert.replace(/\?/g, () => `$${++index}`),
      parameters,
    );
  }
  const debugRepository = sqlite
    ? new SqliteDdtDebugRepository(sqlite)
    : new PostgresDdtDebugRepository(postgres!);
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  for (const id of [ownerId, otherOwnerId]) {
    const statement = `INSERT INTO users (id, username, normalized_username, display_name, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'local', 'active', ?, ?)`;
    const values = [id, id, id, id, now, now];
    if (sqlite) sqlite.client.prepare(statement).run(...values);
    else {
      let index = 0;
      await postgres!.pool.query(
        statement.replace(/\?/g, () => `$${++index}`),
        values,
      );
    }
  }
  const debugService = new DdtDebugService(
    debugRepository,
    ddt,
    { now: () => new Date(now) },
    { next: randomUUID },
  );
  const personalScope = { ...scope, ownerUserId: ownerId };
  const debugAccess = await debugService.workspace(personalScope);
  await debugService.copy(personalScope, "DEBUG-1");
  const imports = new DdtImportService(
    ddt,
    objectStore,
    { parseUpload: parseDdtUpload },
    { now: () => new Date(now) },
    { next: randomUUID },
    undefined,
    undefined,
    debugRepository,
  );
  const runnerId = randomUUID();
  await runners.register({
    id: runnerId,
    bootstrapTokenHash: randomUUID(),
    credentialHash: randomUUID(),
    name: "debug runner",
    os: "linux",
    architecture: "amd64",
    agentVersion: "0.7.2",
    protocolVersion: 1,
    labels: ["java", "testng"],
    capabilities: [
      "executor:testng-v1",
      "isolation:cgroup-v2",
      "java:21.0.8",
      "testng:7.11.0",
      "adapter:cotest-testng-v1",
      "adapter:ddt-insight-url-v1",
      "adapter:ddt-case-id-v1",
    ],
    maxConcurrency: 8,
    terminalEnabled: false,
    recordedAt: now,
  });
  const registered = (await runners.listByIds([runnerId], now))[0]!;
  await runners.heartbeat({
    runnerId,
    labels: registered.labels,
    capabilities: registered.capabilities,
    maxConcurrency: 8,
    busySlots: 0,
    agentVersion: registered.agentVersion,
    terminalEnabled: false,
    resourceSnapshot: {
      cpuUtilizationPercent: 1,
      memoryUtilizationPercent: 1,
      loadAverage1m: 0,
      logicalCpuCount: 8,
      observedAt: now,
    },
    recordedAt: now,
  });
  const service = new RunBatchSchedulingService(
    batches,
    suites,
    runners,
    { now: () => new Date(now) },
    { next: randomUUID },
    { maximumCpuUtilizationPercent: 85, maximumMemoryUtilizationPercent: 85, maximumLoadPerCpu: 1 },
    45,
    { catalog, objectStore, ddt, ddtDebug: debugRepository },
    128,
    5,
    structures,
  );
  return {
    sqlite,
    ownerId,
    otherOwnerId,
    debugAccess,
    debugRepository,
    debugService,
    imports,
    service,
    scope,
    classId,
    runnerId,
    batches,
    ddt,
    catalog,
    structures,
    suites,
    now,
    assetId: asset.id,
    assignmentSpec: async (batchId: string, executionRunId?: string) => {
      const row = sqlite
        ? (sqlite.client
            .prepare(
              "SELECT execution_spec_json FROM assignments WHERE batch_id = ? AND (? IS NULL OR execution_run_id = ?)",
            )
            .get(batchId, executionRunId ?? null, executionRunId ?? null) as
            { execution_spec_json: string } | undefined)
        : (
            await postgres!.pool.query<{ execution_spec_json: string }>(
              "SELECT execution_spec_json FROM assignments WHERE batch_id = $1 AND ($2::text IS NULL OR execution_run_id = $2)",
              [batchId, executionRunId ?? null],
            )
          ).rows[0];
      expect(row, "execution must be assigned to the online Runner").toBeDefined();
      return executionSpecSchema.parse(JSON.parse(row!.execution_spec_json));
    },
    close: async () => {
      sqlite?.close();
      await postgres?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
