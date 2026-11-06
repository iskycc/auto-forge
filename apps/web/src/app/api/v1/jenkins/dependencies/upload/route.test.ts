import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
import { authenticateRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn(),
  requireSameOrigin: vi.fn(),
  requestId: () => "upload-test",
}));
vi.mock("@/lib/services", () => ({ getPlatformServices: vi.fn() }));

describe("Jenkins direct dependency upload", () => {
  let directory: string;
  const authorize = vi.fn();
  const audit = vi.fn();
  const publish = vi.fn();
  const bytes = Buffer.from([0x50, 0x4b, 3, 4, 8, 9]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(join(tmpdir(), "jenkins-upload-route-"));
    vi.mocked(authenticateRequest).mockResolvedValue({ user: { id: "ci-account" } } as Awaited<
      ReturnType<typeof authenticateRequest>
    >);
    vi.mocked(getPlatformServices).mockResolvedValue({
      config: { dataDirectory: directory },
      identityAccess: { authorize, recordAuthorizedOperation: audit },
      projectStructures: { replaceUploadedVersionDependency: publish },
    } as unknown as Awaited<ReturnType<typeof getPlatformServices>>);
    authorize.mockImplementation(() => undefined);
    publish.mockImplementation(async (input) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.content) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(bytes);
      return { version: { id: "version", name: "中文版本" }, asset: { id: "managed-asset" } };
    });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const request = (sha256 = digest) =>
    new Request(
      "http://platform/api/v1/jenkins/dependencies/upload?projectId=project&version=" +
        encodeURIComponent("中文版本"),
      {
        method: "POST",
        headers: {
          "x-autoforge-file-name": encodeURIComponent("依赖 包.zip"),
          "x-autoforge-sha256": sha256,
          "content-length": String(bytes.length),
        },
        body: bytes,
      },
    );
  it("streams verified bytes into a managed version asset and removes staging files", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      assetId: "managed-asset",
      sourceType: "upload",
      fileName: "依赖 包.zip",
      sha256: digest,
      sizeBytes: bytes.length,
    });
    expect(authorize).toHaveBeenCalledWith(expect.anything(), "project.manage", "project");
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project",
        version: "中文版本",
        actorId: "ci-account",
        sha256: digest,
      }),
    );
    expect(await readdir(join(directory, "upload-staging"))).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "jenkins.project_dependency.upload" }),
    );
  });
  it("rejects an altered file before modifying the version", async () => {
    const response = await POST(request("a".repeat(64)));
    expect(response.status).toBe(400);
    expect(publish).not.toHaveBeenCalled();
    expect(await readdir(join(directory, "upload-staging"))).toEqual([]);
  });
  it("checks project permissions before reading or staging the body", async () => {
    authorize.mockImplementation(() => {
      throw new DomainError("AUTH_FORBIDDEN", "没有管理项目权限。");
    });
    expect((await POST(request())).status).toBe(403);
    expect(publish).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
});
