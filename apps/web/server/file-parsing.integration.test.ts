import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { WorkerPool } from "./worker-pool";
import { webResourcePlan } from "../src/lib/worker-sizing";
import { buildClassFile } from "../../../packages/testng-discovery/test/class-fixture";

describe("isolated upload parsing", () => {
  it.each(["lite", "full"] as const)(
    "preserves JAR metadata, DDT conflicts and admission recovery in %s without opening a database",
    async (mode) => {
      const pool = new WorkerPool(
        {
          mode,
          imports: { maxJarBytes: 16 * 1024 ** 2, targetJavaVersion: 21 },
          dataDirectory: "unused",
          migrationsFolder: "unused",
          attemptLogsDirectory: "unused",
          caseExecutionTimeoutSeconds: 60,
          artifactCollectionEnabled: false,
          scheduler: {
            maximumCpuUtilizationPercent: 90,
            maximumMemoryUtilizationPercent: 90,
            maximumLoadPerCpu: 2,
            metricsMaximumAgeSeconds: 60,
            projectMaximumConcurrency: 500,
            priorityAgingIntervalMinutes: 1,
          },
        },
        2,
        5_000,
        webResourcePlan({ cpuCapacity: 1, memoryCapacityBytes: 4 * 1024 ** 3 }, mode),
      );
      try {
        const content = zipSync({
          "example/Sample.class": buildClassFile({
            className: "example.Sample",
            methods: [{ name: "passes", annotations: [{ type: "Test", values: {} }] }],
          }),
        });
        const inspection = pool.parseFile("inspect-jar", { fileName: "sample.jar", content });
        const conflicted = pool.parseFile("parse-ddt", {
          fileName: "cases.csv",
          mediaType: "text/csv",
          content: Buffer.from("CaseID,srNum,name,name\na,S,x,y\n"),
        });
        const settled = Promise.allSettled([inspection, conflicted]);
        await expect(
          pool.parseFile("inspect-jar", { fileName: "overflow.jar", content }),
        ).rejects.toMatchObject({ code: "PLATFORM_BUSY" });
        const [jar, ddt] = await settled;
        expect(jar).toMatchObject({
          status: "fulfilled",
          value: { classes: [{ className: "example.Sample" }] },
        });
        expect(ddt).toMatchObject({
          status: "rejected",
          reason: {
            code: "DDT_DUPLICATE_COLUMNS",
            fileName: "cases.csv",
            conflicts: expect.any(Array),
          },
        });
        await expect(
          pool.parseFile("parse-ddt", {
            fileName: "valid.csv",
            mediaType: "text/csv",
            content: Buffer.from("CaseID,srNum,name\na,S,x\n"),
          }),
        ).resolves.toMatchObject([{ rows: [{ CaseID: "a", srNum: "S", name: "x" }] }]);

        const ddtArchive = zipSync({
          "a.csv": Buffer.from("CaseID,srNum\na,A\n"),
          "b.csv": Buffer.from("CaseID,srNum\nb,B\n"),
        });
        await expect(
          pool.parseFile("parse-ddt", {
            fileName: "cases.zip",
            mediaType: "application/zip",
            content: ddtArchive,
            parseLimits: { maximumZipSpreadsheets: 1 },
          }),
        ).rejects.toThrow("ZIP 中可导入的表格超过 1 个的配置上限");
        await expect(
          pool.parseFile("parse-ddt", {
            fileName: "cases.zip",
            mediaType: "application/zip",
            content: ddtArchive,
            parseLimits: { maximumZipSpreadsheets: 2 },
          }),
        ).resolves.toHaveLength(2);
      } finally {
        await pool.close();
      }
    },
    30_000,
  );
});
