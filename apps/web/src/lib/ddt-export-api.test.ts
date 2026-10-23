import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openTemporaryExportFile } from "./export-temporary-file";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), prepare: vi.fn() }));
vi.mock("./auth", () => ({
  authenticateRequest: async () => ({ user: { id: "reader" } }),
  requestId: () => "test-request",
  requireSameOrigin: vi.fn(),
}));
vi.mock("./ddt-api", () => ({ authorizeDdtScope: mocks.authorize, ddtScopeQuery: vi.fn() }));
vi.mock("./ddt-export-file", () => ({ prepareDdtExportFile: mocks.prepare }));
import { GET, HEAD, POST } from "../app/api/v1/ddt/[...path]/route";

it.each([
  { method: "GET", selection: {}, range: "全部用例" },
  { method: "HEAD", selection: {}, range: "全部用例" },
  { method: "POST", selection: {}, range: "全部用例" },
  { method: "POST", selection: { caseIds: ["中文CaseID"] }, range: "已选用例" },
  { method: "GET", selection: { srNum: "Wallet" }, range: "筛选范围" },
] as const)(
  "names and closes the prepared DDT $method download for $range",
  async ({ method, selection, range }) => {
    const directory = await mkdtemp(join(tmpdir(), "ddt-export-http-"));
    const file = await openTemporaryExportFile(directory);
    const content = Buffer.alloc(512 * 1_024, 7);
    await file.writeFile(content);
    const scope = { projectId: "project", projectVersionId: "version", testStageId: "stage" };
    const exportPages = vi.fn(async function* () {
      yield [];
    });
    mocks.authorize.mockResolvedValue({
      scope,
      labels: { version: "1.20", stage: "系统测试" },
      services: {
        clock: { now: () => new Date("2026-10-23T10:30:45Z") },
        ddtCases: { exportPages },
        configurationStore: {
          paths: { dataDirectory: directory },
          read: () => ({ web: { timeZone: "Asia/Shanghai" } }),
        },
      },
    });
    mocks.prepare.mockResolvedValue({ file, sizeBytes: content.length });
    const request = new Request(
      `http://localhost/api/v1/ddt/export?${new URLSearchParams({ ...scope, ...(method === "GET" && "srNum" in selection ? { srNum: selection.srNum } : {}) })}`,
      {
        method,
        ...(method === "POST"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(selection),
            }
          : {}),
      },
    );
    try {
      const response = await (method === "GET" ? GET : method === "HEAD" ? HEAD : POST)(request, {
        params: Promise.resolve({ path: ["export"] }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(content.length));
      expect(decodeURIComponent(response.headers.get("content-disposition")!)).toContain(
        `1.20-系统测试_DDT用例清单_${range}_20261023-183045.xlsx`,
      );
      if (method !== "HEAD") expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
      else expect(response.body).toBeNull();
      await expect.poll(() => file.fd).toBe(-1);
      expect(mocks.authorize).toHaveBeenLastCalledWith(
        expect.anything(),
        "case.read",
        expect.any(URL),
      );
      expect(exportPages).toHaveBeenCalledWith(scope, selection, request.signal);
    } finally {
      await file.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
