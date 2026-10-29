import { createHash } from "node:crypto";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
const access = vi.hoisted(() => ({
  authorize: vi.fn(),
  sameOrigin: vi.fn(),
  create: vi.fn(),
  cleanup: vi.fn(),
  cancel: vi.fn(),
  find: vi.fn(),
  list: vi.fn(),
  openRead: vi.fn(),
  recordDownload: vi.fn(),
  removeCopy: vi.fn(),
  retry: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authorizeRequest: access.authorize,
  requireSameOrigin: access.sameOrigin,
  requestId: () => "archive-api-test",
}));
vi.mock("@/lib/services", () => ({
  getPlatformServices: async () => ({
    logArchives: {
      create: access.create,
      cleanup: access.cleanup,
      cancel: access.cancel,
      find: access.find,
      list: access.list,
      recordDownload: access.recordDownload,
      removeCopy: access.removeCopy,
      retry: access.retry,
    },
    objectStore: { openRead: access.openRead },
    identityAccess: { recordAuthorizedOperation: access.audit },
  }),
}));
import { GET, POST } from "../app/api/v1/settings/log-archives/route";
import { POST as cleanup } from "../app/api/v1/settings/log-archives/[archiveId]/cleanup/route";
import { POST as cancel } from "../app/api/v1/settings/log-archives/[archiveId]/cancel/route";
import { POST as removeCopy } from "../app/api/v1/settings/log-archives/[archiveId]/remove-copy/route";
import { POST as retry } from "../app/api/v1/settings/log-archives/[archiveId]/retry/route";
import { GET as download } from "../app/api/v1/settings/log-archives/[archiveId]/download/route";
const id = "019a25a1-0000-7000-8000-000000000001",
  context = { params: Promise.resolve({ archiveId: id }) };
function request(method: string, body?: unknown) {
  return new Request("http://localhost/api/v1/settings/log-archives", {
    method,
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  access.authorize.mockResolvedValue({ user: { id: "administrator" } });
  access.sameOrigin.mockImplementation(() => {});
});
describe("monthly log archive HTTP boundary", () => {
  it.each(["create", "cleanup", "cancel", "download", "list", "removeCopy", "retry"] as const)(
    "requires permission before %s",
    async (action) => {
      access.authorize.mockRejectedValue(new DomainError("AUTH_FORBIDDEN", "无权限"));
      const response = await {
        create: () => POST(request("POST", { month: "2026-10" })),
        cleanup: () => cleanup(request("POST", { confirm: true }), context),
        cancel: () => cancel(request("POST"), context),
        download: () => download(request("GET"), context),
        list: () => GET(request("GET")),
        removeCopy: () =>
          removeCopy(
            request("POST", { downloadedAndVerified: true, sha256: "a".repeat(64) }),
            context,
          ),
        retry: () => retry(request("POST"), context),
      }[action]();
      expect(response.status).toBe(403);
      expect(access[action === "download" ? "openRead" : action]).not.toHaveBeenCalled();
    },
  );
  it("requires global log access for archive generation and records the operator", async () => {
    access.create.mockResolvedValue({ id, month: "2026-10", status: "queued" });
    const response = await POST(request("POST", { month: "2026-10" }));
    expect(response.status).toBe(202);
    expect(access.authorize).toHaveBeenCalledWith(expect.any(Request), "log.read", undefined);
    expect(access.create).toHaveBeenCalledWith(
      expect.objectContaining({ month: "2026-10", targetVolumeMiB: 1024, minimumFreeMiB: 1024 }),
      "administrator",
    );
    expect(access.audit).toHaveBeenCalled();
  });
  it("requires explicit cleanup confirmation and same-origin protection", async () => {
    expect((await cleanup(request("POST", {}), context)).status).toBe(400);
    expect(access.cleanup).not.toHaveBeenCalled();
    access.sameOrigin.mockImplementation(() => {
      throw new DomainError("CSRF_REJECTED", "来源错误");
    });
    expect((await cleanup(request("POST", { confirm: true }), context)).status).toBe(403);
    expect(access.cleanup).not.toHaveBeenCalled();
  });
  it("does not download an unverified file and preserves a stable conflict message", async () => {
    access.find.mockResolvedValue({ id, status: "building" });
    const response = await download(request("GET"), context);
    expect(response.status).toBe(409);
    expect(access.openRead).not.toHaveBeenCalled();
  });
  it("streams the verified immutable archive and records its complete download", async () => {
    const checksum = createHash("sha256")
      .update(new Uint8Array([1, 2, 3]))
      .digest("hex");
    access.find.mockResolvedValue({
      id,
      objectKey: "log-archives/fixture.zip",
      filename: "AutoForge_执行日志归档_202610_fixture.zip",
      sha256: checksum,
      archiveBytes: 3,
    });
    access.openRead.mockResolvedValue({
      sizeBytes: 3,
      content: (async function* () {
        yield new Uint8Array([1, 2, 3]);
      })(),
    });
    const response = await download(request("GET"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-sha256")).toBe(checksum);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(access.recordDownload).toHaveBeenCalledWith(id, "administrator", checksum, 3);
  });
  it("requires an explicit downloaded-and-verified confirmation and audits removal", async () => {
    expect(
      (
        await removeCopy(
          request("POST", { downloadedAndVerified: false, sha256: "a".repeat(64) }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(access.removeCopy).not.toHaveBeenCalled();
    expect(
      (
        await removeCopy(
          request("POST", { downloadedAndVerified: true, sha256: "a".repeat(64) }),
          context,
        )
      ).status,
    ).toBe(202);
    expect(access.removeCopy).toHaveBeenCalledWith(id, "administrator", "a".repeat(64));
    expect(access.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "platform.log_archive_copy_removal_requested" }),
    );
  });
  it("never records an aborted download or opens a removed copy", async () => {
    access.find.mockResolvedValue({
      id,
      objectKey: "fixture.zip",
      filename: "fixture.zip",
      sha256: "a".repeat(64),
      archiveBytes: 3,
    });
    access.openRead.mockResolvedValue({
      sizeBytes: 3,
      content: (async function* () {
        yield new Uint8Array([1, 2, 3]);
      })(),
    });
    const controller = new AbortController();
    const response = await download(
      new Request("http://localhost/download", { signal: controller.signal }),
      context,
    );
    controller.abort();
    await response.arrayBuffer();
    expect(access.recordDownload).not.toHaveBeenCalled();
    access.openRead.mockClear();
    access.find.mockResolvedValue({
      id,
      objectKey: "fixture.zip",
      filename: "fixture.zip",
      sha256: "a".repeat(64),
      copyState: "deleted",
    });
    expect((await download(request("GET"), context)).status).toBe(410);
    expect(access.openRead).not.toHaveBeenCalled();
  });
  it("does not confirm corrupted downloads with matching file sizes", async () => {
    access.find.mockResolvedValue({
      id,
      objectKey: "fixture.zip",
      filename: "fixture.zip",
      sha256: "a".repeat(64),
      archiveBytes: 3,
    });
    access.openRead.mockResolvedValue({
      sizeBytes: 3,
      content: (async function* () {
        yield new Uint8Array([1, 2, 3]);
      })(),
    });
    const response = await download(request("GET"), context);
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(access.recordDownload).not.toHaveBeenCalled();
  });
});
