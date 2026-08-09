import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { SqliteRunnerRepository } from "../src/sqlite-runner";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite management repositories", () => {
  it("switches the authoritative source and adds and removes suite cases transactionally", async () => {
    const { handle, catalog, suites } = await fixture();
    try {
      const source = await catalog.setAuthoritativeSource("source-1");
      expect(source.authoritative).toBe(true);
      expect((await catalog.getSource("source-1"))?.inspection.testMethodCount).toBe(1);

      await suites.create({ id: "suite-1", name: "Smoke", createdAt: timestamp });
      const withCase = await suites.addCases({
        suiteId: "suite-1",
        items: [{ id: "item-1", caseDefinitionId: "case-1" }],
        updatedAt: timestamp,
      });
      expect(withCase).toMatchObject({ caseCount: 1, version: 2 });
      expect(withCase.items[0]?.caseDefinition.className).toBe("com.example.SmokeTest");

      const empty = await suites.removeCase({
        suiteId: "suite-1",
        caseDefinitionId: "case-1",
        updatedAt: "2026-08-09T00:01:00.000Z",
      });
      expect(empty).toMatchObject({ caseCount: 0, version: 3 });
    } finally {
      handle.close();
    }
  });

  it("derives online and offline runner state from heartbeat time", async () => {
    const { handle, runners } = await fixture();
    try {
      await runners.register({
        id: "runner-1",
        bootstrapTokenHash: "bootstrap-hash-1",
        credentialHash: "hash-1",
        name: "linux-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.1.0",
        protocolVersion: 1,
        labels: ["java"],
        maxConcurrency: 2,
        terminalEnabled: false,
        recordedAt: timestamp,
      });
      await expect(
        runners.register({
          id: "runner-duplicate",
          bootstrapTokenHash: "bootstrap-hash-1",
          credentialHash: "hash-duplicate",
          name: "duplicate",
          os: "linux",
          architecture: "amd64",
          agentVersion: "0.1.0",
          protocolVersion: 1,
          labels: [],
          maxConcurrency: 1,
          terminalEnabled: false,
          recordedAt: timestamp,
        }),
      ).resolves.toBeNull();
      expect((await runners.list("2026-08-08T23:59:00.000Z", 100))[0]?.state).toBe("online");
      expect((await runners.list("2026-08-09T00:00:30.000Z", 100))[0]?.state).toBe("offline");
      const heartbeat = await runners.heartbeat({
        runnerId: "runner-1",
        labels: ["java", "testng"],
        maxConcurrency: 2,
        busySlots: 1,
        agentVersion: "0.1.1",
        terminalEnabled: true,
        recordedAt: "2026-08-09T00:01:00.000Z",
      });
      expect(heartbeat).toMatchObject({ busySlots: 1, terminalEnabled: true });
      const terminalDisabled = await runners.heartbeat({
        runnerId: "runner-1",
        labels: ["java"],
        maxConcurrency: 2,
        busySlots: 0,
        agentVersion: "0.1.1",
        terminalEnabled: false,
        recordedAt: "2026-08-09T00:02:00.000Z",
      });
      expect(terminalDisabled.terminalEnabled).toBe(false);
    } finally {
      handle.close();
    }
  });

  it("reconstructs previews imported before inspection snapshots were persisted", async () => {
    const { handle, catalog } = await fixture();
    try {
      handle.client
        .prepare("UPDATE case_sources SET inspection_json = '{}' WHERE id = ?")
        .run("source-1");

      const source = await catalog.getSource("source-1");

      expect(source?.inspection.classes[0]?.className).toBe("com.example.SmokeTest");
      expect(source?.inspection.warnings).toContainEqual(
        expect.objectContaining({ code: "LEGACY_INSPECTION_RECONSTRUCTED" }),
      );
    } finally {
      handle.close();
    }
  });
});

const timestamp = "2026-08-09T00:00:00.000Z";

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-management-"));
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
  };
}
