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
import { GET, HEAD } from "../app/api/v1/ddt/[...path]/route";

it.each(["GET", "HEAD"] as const)(
  "closes the prepared DDT download after %s reads or cancels it",
  async (method) => {
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
      services: {
        ddtCases: { exportPages },
        configurationStore: { paths: { dataDirectory: directory } },
      },
    });
    mocks.prepare.mockResolvedValue({ file, sizeBytes: content.length });
    const request = new Request(
      `http://localhost/api/v1/ddt/export?${new URLSearchParams(scope)}`,
      { method },
    );
    try {
      const response = await (method === "GET" ? GET : HEAD)(request, {
        params: Promise.resolve({ path: ["export"] }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(content.length));
      if (method === "GET") expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
      else expect(response.body).toBeNull();
      await expect.poll(() => file.fd).toBe(-1);
      expect(mocks.authorize).toHaveBeenLastCalledWith(
        expect.anything(),
        "case.read",
        expect.any(URL),
      );
      expect(exportPages).toHaveBeenCalledWith(scope, {}, request.signal);
    } finally {
      await file.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
