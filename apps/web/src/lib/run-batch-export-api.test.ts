import type { RunBatchExportRow } from "@autoforge/application";
import ExcelJS from "exceljs";
import { DomainError } from "@autoforge/domain";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const {
  authenticateRequest,
  projectScope,
  buildExport,
  ensureShares,
  readConfiguration,
  listClaims,
  paths,
} = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  projectScope: vi.fn(),
  buildExport: vi.fn(),
  ensureShares: vi.fn(),
  readConfiguration: vi.fn(),
  listClaims: vi.fn(),
  paths: { dataDirectory: "" },
}));
vi.mock("./auth", () => ({ authenticateRequest }));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    identityAccess: { projectScope },
    runBatchExport: { prepare: buildExport },
    publicExecutionAccess: { ensureLinksForAttemptsInBatch: ensureShares },
    configurationStore: { read: readConfiguration, paths },
    failureAnalysis: { listExportClaims: listClaims },
  }),
}));

import { GET, HEAD } from "../app/api/v1/run-batches/[batchId]/export/route";

const row: RunBatchExportRow = {
  attemptId: "attempt-failed",
  executionRunId: "run-failed",
  casePath: "com.example.PaymentTest",
  displayName: "支付验证",
  outcome: "failed",
  resultCode: "TESTNG_ASSERTIONS_FAILED",
  summary: "Assertion failure",
  startedAt: "2026-10-07T16:00:00.123Z",
  finishedAt: "2026-10-07T16:01:00.123Z",
  durationMs: 60_000,
  round: 1,
};

beforeEach(async () => {
  paths.dataDirectory = await mkdtemp(join(tmpdir(), "autoforge-export-api-test-"));
  vi.resetAllMocks();
  authenticateRequest.mockResolvedValue({ user: { id: "reader" } });
  projectScope.mockReturnValue(["project"]);
  buildExport.mockImplementation(async () => ({
    projectId: "project",
    pages: (async function* () {
      yield [row];
    })(),
  }));
  ensureShares.mockResolvedValue(
    new Map([["attempt-failed", "/CaseLog?ExecutionId=attempt-failed"]]),
  );
  listClaims.mockResolvedValue([]);
  readConfiguration.mockReturnValue({
    web: { timeZone: "Asia/Shanghai", publicBaseUrl: "http://localhost" },
  });
});

afterEach(async () => {
  await rm(paths.dataDirectory, { recursive: true, force: true });
});

describe("validated Excel downloads", () => {
  it("closes a HEAD response body while retaining the authenticated download headers", async () => {
    const response = await HEAD(
      new Request("http://localhost/api/v1/run-batches/batch/export?scope=final&outcomes=failed", {
        method: "HEAD",
      }),
      { params: Promise.resolve({ batchId: "batch" }) },
    );
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-type")).toContain("spreadsheetml");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
  });
  const bad = {
    ...row,
    executionRunId: "run-bad",
    attemptId: "attempt-bad",
    summary: "不合法\ufffe堆栈",
  };
  const last = {
    ...row,
    executionRunId: "run-last",
    attemptId: "attempt-last",
    displayName: "正常中文😀",
  };
  function mixedPages() {
    buildExport.mockImplementation(async () => ({
      projectId: "project",
      pages: (async function* () {
        yield [row];
        yield [bad];
        yield [last];
      })(),
    }));
    ensureShares.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, `/CaseLog?ExecutionId=${id}`])),
    );
  }
  async function requestExport(query = "") {
    return GET(
      new Request(
        `http://localhost/api/v1/run-batches/batch/export?scope=final&template=failure-analysis${query}`,
      ),
      { params: Promise.resolve({ batchId: "batch" }) },
    );
  }
  it("reports invalid later-page records before sending any XLSX headers", async () => {
    mixedPages();
    const response = await requestExport();
    expect(response.status).toBe(422);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toMatchObject({
      error: {
        code: "EXPORT_DATA_INVALID",
        details: {
          totalRows: 3,
          validRows: 2,
          excludedRows: 1,
          issues: [
            {
              rowNumber: 3,
              executionRunId: "run-bad",
              fields: [{ field: "失败堆栈", reason: expect.stringContaining("U+FFFE") }],
            },
          ],
        },
      },
    });
    expect(ensureShares.mock.calls.flatMap(([ids]) => ids)).not.toContain("attempt-bad");
  });
  it("excludes the complete invalid record and includes a safe full exclusion sheet", async () => {
    mixedPages();
    const response = await requestExport("&invalidRows=exclude");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-autoforge-export-excluded-rows")).toBe("1");
    const bytes = await response.arrayBuffer();
    expect(Number(response.headers.get("content-length"))).toBe(bytes.byteLength);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const sheet = workbook.getWorksheet("失败用例分析清单")!;
    expect(sheet.rowCount).toBe(3);
    expect(sheet.getCell("B3").value).toBe("正常中文😀");
    const issues = workbook.getWorksheet("排除明细")!;
    expect(issues.getCell("B2").value).toBe("run-bad");
    expect(issues.getCell("G2").value).toContain("U+FFFE");
  });
  it("returns a JSON error when a later page fails rather than an incomplete ZIP", async () => {
    buildExport.mockResolvedValue({
      projectId: "project",
      pages: (async function* () {
        yield [row];
        throw new DomainError("PLATFORM_BUSY", "执行信息读取繁忙。");
      })(),
    });
    const response = await requestExport();
    expect(response.status).toBe(503);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: "PLATFORM_BUSY" } });
  });
  it("keeps authentication ahead of validation and file generation", async () => {
    authenticateRequest.mockRejectedValue(new DomainError("AUTH_REQUIRED", "请登录。"));
    const response = await requestExport("&invalidRows=exclude");
    expect(response.status).toBe(401);
    expect(buildExport).not.toHaveBeenCalled();
    expect(ensureShares).not.toHaveBeenCalled();
  });
  it("refuses unsupported exclusion policies", async () => {
    const response = await requestExport("&invalidRows=delete");
    expect(response.status).toBe(400);
    expect(buildExport).not.toHaveBeenCalled();
  });
});

describe("execution result export time zone", () => {
  it.each([
    { timeZone: "Asia/Shanghai", start: "2026-10-08 00:00:00.123", end: "2026-10-08 00:01:00.123" },
    {
      timeZone: "America/New_York",
      start: "2026-10-07 12:00:00.123",
      end: "2026-10-07 12:01:00.123",
    },
  ])(
    "downloads timestamps using the persisted $timeZone setting",
    async ({ timeZone, start, end }) => {
      readConfiguration.mockReturnValue({ web: { timeZone, publicBaseUrl: "http://localhost" } });
      const response = await GET(
        new Request("http://localhost/api/v1/run-batches/batch/export?scope=final&outcomes=failed"),
        { params: Promise.resolve({ batchId: "batch" }) },
      );
      expect(response.status).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await response.arrayBuffer());
      const sheet = workbook.getWorksheet("执行结果")!;
      expect(sheet.getCell("E2").value).toBe(start);
      expect(sheet.getCell("F2").value).toBe(end);
      expect(sheet.getCell("G2").value).toBe(60);
      expect(sheet.getCell("H2").hyperlink).toBe(
        "http://localhost/CaseLog?ExecutionId=attempt-failed",
      );
      expect(buildExport).toHaveBeenCalledWith({
        batchId: "batch",
        scope: "final",
        outcomes: ["failed"],
        projectIds: ["project"],
      });
    },
  );
});
