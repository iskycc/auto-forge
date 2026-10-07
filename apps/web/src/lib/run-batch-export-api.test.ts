import type { RunBatchExportRow } from "@autoforge/application";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { authenticateRequest, projectScope, buildExport, ensureShares, readConfiguration } =
  vi.hoisted(() => ({
    authenticateRequest: vi.fn(),
    projectScope: vi.fn(),
    buildExport: vi.fn(),
    ensureShares: vi.fn(),
    readConfiguration: vi.fn(),
  }));
vi.mock("./auth", () => ({ authenticateRequest }));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    identityAccess: { projectScope },
    runBatchExport: { build: buildExport },
    attemptLogShares: { ensureSharesForAttemptsInBatch: ensureShares },
    configurationStore: { read: readConfiguration },
  }),
}));

import { GET } from "../app/api/v1/run-batches/[batchId]/export/route";

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

beforeEach(() => {
  vi.resetAllMocks();
  authenticateRequest.mockResolvedValue({ user: { id: "reader" } });
  projectScope.mockReturnValue(["project"]);
  buildExport.mockResolvedValue({ projectId: "project", rows: [row] });
  ensureShares.mockResolvedValue(new Map());
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
      expect(buildExport).toHaveBeenCalledWith({
        batchId: "batch",
        scope: "final",
        outcomes: ["failed"],
        projectIds: ["project"],
      });
    },
  );
});
