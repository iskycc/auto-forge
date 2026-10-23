import { beforeEach, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { parseExportFilename } from "./run-batch-export";

vi.mock("server-only", () => ({}));
const { authenticateRequest, projectScope, prepareCaseExport } = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  projectScope: vi.fn(),
  prepareCaseExport: vi.fn(),
}));
vi.mock("./auth", () => ({ authenticateRequest, requestId: () => "export-request" }));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    identityAccess: { projectScope },
    caseSuites: { prepareCaseExport },
    clock: { now: () => new Date("2026-10-23T16:30:45Z") },
    configurationStore: { read: () => ({ web: { timeZone: "Asia/Shanghai" } }) },
  }),
}));
import { GET } from "../app/api/v1/case-suites/[suiteId]/export/route";

beforeEach(() => {
  vi.resetAllMocks();
  authenticateRequest.mockResolvedValue({ user: { id: "reader" } });
  projectScope.mockReturnValue(["project"]);
});

it("downloads named task members through the existing permission scope without changing the workbook", async () => {
  prepareCaseExport.mockResolvedValue({
    suite: { id: "suite", name: "每日/冒烟" },
    rows: (async function* () {
      yield { memberId: "member", casePath: "example.Case", displayName: "中文用例" };
    })(),
  });
  const response = await GET(new Request("http://localhost/api/v1/case-suites/suite/export"), {
    params: Promise.resolve({ suiteId: "suite" }),
  });
  expect(response.status).toBe(200);
  expect(parseExportFilename(response.headers.get("content-disposition"))).toBe(
    "每日-冒烟_任务用例清单_20261024-003045.xlsx",
  );
  expect(prepareCaseExport).toHaveBeenCalledWith("suite", ["project"]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await response.arrayBuffer());
  expect(workbook.worksheets[0]!.getRow(2).values).toEqual([undefined, "example.Case", "中文用例"]);
  expect(workbook.worksheets[0]!.getColumn(1).width).toBe(52);
});
