import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";

vi.mock("server-only", () => ({}));
const runtime = vi.hoisted(() => ({
  authenticate: vi.fn(),
  prepare: vi.fn(),
  scope: vi.fn(),
  authorize: vi.fn(),
  logs: vi.fn(),
  paths: { dataDirectory: "" },
}));
vi.mock("./auth", () => ({ authenticateRequest: runtime.authenticate }));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    runBatchExport: { prepare: runtime.prepare },
    identityAccess: { projectScope: runtime.scope, authorize: runtime.authorize },
    executionControl: { listLogs: runtime.logs },
    clock: { now: () => new Date("2026-11-05T03:00:00Z") },
    configurationStore: {
      paths: runtime.paths,
      read: () => ({ web: { timeZone: "Asia/Shanghai" } }),
    },
  }),
}));
import { GET } from "../app/api/v1/run-batches/[batchId]/failure-logs/export/route";
const row = {
  attemptId: "attempt",
  casePath: "com.example.Wallet",
  displayName: "Wallet",
  round: 1,
};
beforeEach(async () => {
  vi.resetAllMocks();
  runtime.paths.dataDirectory = await mkdtemp(join(tmpdir(), "failure-log-api-"));
  runtime.authenticate.mockResolvedValue({ user: { id: "reader" } });
  runtime.scope.mockReturnValue(["project"]);
  runtime.prepare.mockImplementation(async () => ({
    projectId: "project",
    batch: { suiteName: "钱包", sequenceNumber: 123 },
    pages: (async function* () {
      yield [
        row,
        {
          ...row,
          attemptId: "ddt",
          casePath: "com.example.Adapter",
          displayName: "中文CaseID",
          ddt: { caseName: "name", srId: "sr" },
        },
      ];
    })(),
  }));
  runtime.logs.mockImplementation(async ({ attemptId, stream, afterSequence }) => ({
    items:
      stream === "stdout"
        ? [{ content: afterSequence === -1 ? `\u001b[31m${attemptId}` : "结束\u001b[0m" }]
        : [],
    ...(stream === "stdout" && afterSequence === -1 ? { nextSequence: 0 } : {}),
    acknowledgedSequence: 1,
    truncated: false,
  }));
});
afterEach(async () => {
  await rm(runtime.paths.dataDirectory, { recursive: true, force: true });
});
const request = (query: string, signal?: AbortSignal) =>
  new Request(
    `http://localhost/api/v1/run-batches/batch/failure-logs/export?${query}`,
    signal ? { signal } : {},
  );
const context = { params: Promise.resolve({ batchId: "batch" }) };

describe("independent failure log download", () => {
  it.each(["final", "round&round=2", "all"])(
    "exports %s with fixed failure scope and separate log permission",
    async (scope) => {
      const response = await GET(request(`scope=${scope}&outcomes=succeeded`), context);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/zip");
      expect(response.headers.get("content-disposition")).toContain("AutoForge-export.zip");
      expect(decodeURIComponent(response.headers.get("content-disposition")!)).toContain(
        "_失败用例日志_",
      );
      expect(runtime.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ outcomes: ["failed", "blocked"], projectIds: ["project"] }),
      );
      expect(runtime.authorize).toHaveBeenCalledWith(expect.anything(), "log.read", "project");
      const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
      expect(Object.keys(files)).toHaveLength(2);
      expect(Object.keys(files).some((name) => name.startsWith("中文CaseID"))).toBe(true);
      expect(Object.keys(files).some((name) => name.endsWith(".xlsx"))).toBe(false);
      expect(Buffer.from(Object.values(files)[0]!).toString("utf8")).toBe(
        "\ufeff===== stdout =====\nattempt结束",
      );
      expect(runtime.logs).toHaveBeenCalledWith(
        expect.objectContaining({ projectIds: ["project"], limit: 32 }),
      );
    },
  );
  it("rejects missing rounds and denies log access before any content is read", async () => {
    expect((await GET(request("scope=round"), context)).status).toBe(400);
    runtime.authorize.mockImplementation(() => {
      throw new DomainError("AUTH_FORBIDDEN", "没有日志权限。");
    });
    expect((await GET(request("scope=final"), context)).status).toBe(403);
    expect(runtime.logs).not.toHaveBeenCalled();
  });
  it("returns a clear failure rather than a partial ZIP if a later log is unavailable", async () => {
    runtime.logs.mockImplementation(async ({ attemptId }) => {
      if (attemptId === "ddt")
        throw new DomainError("LOG_ARCHIVE_OFFLINE", "日志已离线归档，请从归档包查看。");
      return { items: [], acknowledgedSequence: -1, truncated: false };
    });
    const response = await GET(request("scope=final"), context);
    expect(response.ok).toBe(false);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("离线归档") },
    });
  });
});
