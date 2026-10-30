import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  sameOrigin: vi.fn(),
  session: vi.fn(),
  resolve: vi.fn(),
  permission: vi.fn(),
  find: vi.fn(),
  open: vi.fn(),
  receipt: vi.fn(),
  audit: vi.fn(),
}));
const actorId = "019a25a1-0000-7000-8000-000000000002";
const archiveId = "019a25a1-0000-7000-8000-000000000001";
const identity = {
  user: { id: actorId, status: "active", forcePasswordChange: false },
  sessionId: "session-1",
};
const now = new Date("2026-10-30T00:00:00Z");
vi.mock("@/lib/auth", () => ({
  authorizeRequest: mocks.authorize,
  requireSameOrigin: mocks.sameOrigin,
  sessionTokenFromRequest: mocks.session,
  requestId: () => "archive-links-test",
}));
vi.mock("@/lib/services", () => ({
  getPlatformServices: async () => ({
    config: { masterKey: "archive-test-signing-key-".repeat(3) },
    clock: { now: () => now },
    configurationStore: { read: () => ({ web: { publicBaseUrl: "http://localhost" } }) },
    identities: { resolveSession: mocks.resolve },
    identityAccess: { authorize: mocks.permission, recordAuthorizedOperation: mocks.audit },
    logArchives: { find: mocks.find, recordDownload: mocks.receipt },
    objectStore: { openRead: mocks.open },
  }),
}));
import { POST } from "../app/api/v1/settings/log-archives/download-links/route";
import { GET } from "../app/api/v1/settings/log-archives/[archiveId]/download/route";
const context = { params: Promise.resolve({ archiveId }) };
function request(archiveIds = [archiveId]) {
  return new Request("http://localhost/api/v1/settings/log-archives/download-links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archiveIds }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(identity);
  mocks.session.mockReturnValue("private-session-cookie");
  mocks.resolve.mockResolvedValue(identity);
  const payload = Buffer.from([1, 2, 3]);
  mocks.find.mockResolvedValue({
    id: archiveId,
    objectKey: "archive.zip",
    filename: "中文归档.zip",
    sha256: createHash("sha256").update(payload).digest("hex"),
    archiveBytes: payload.length,
    copyState: "retained",
  });
  mocks.open.mockResolvedValue({
    sizeBytes: payload.length,
    content: (async function* () {
      yield payload;
    })(),
  });
});
async function link() {
  const response = await POST(request());
  expect(response.status).toBe(200);
  return (await response.json()).items[0].url as string;
}
describe("selected archive download authorization", () => {
  it("issues scoped URLs without cookies and copying does not confirm a download", async () => {
    const url = await link();
    expect(url).not.toContain("private-session-cookie");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.receipt).not.toHaveBeenCalled();
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
    expect(mocks.resolve).toHaveBeenCalledWith(
      createHash("sha256").update("private-session-cookie").digest("hex"),
      now.toISOString(),
    );
    expect(mocks.permission).toHaveBeenCalledWith(identity, "log.read", undefined);
    expect(mocks.receipt).toHaveBeenCalledWith(archiveId, actorId, expect.any(String), 3);
  });
  it("enforces authentication, global permissions, CSRF and bounded unique selections", async () => {
    mocks.authorize.mockRejectedValueOnce(new DomainError("AUTH_FORBIDDEN", "无权限"));
    expect((await POST(request())).status).toBe(403);
    expect(mocks.find).not.toHaveBeenCalled();
    mocks.sameOrigin.mockImplementationOnce(() => {
      throw new DomainError("CSRF_REJECTED", "来源错误");
    });
    expect((await POST(request())).status).toBe(403);
    expect((await POST(request([archiveId, archiveId]))).status).toBe(400);
    mocks.session.mockReturnValue("");
    expect((await POST(request())).status).toBe(401);
  });
  it("rejects expired sessions, disabled users, changed permissions and invalid tickets even with ambient auth", async () => {
    const url = await link();
    mocks.resolve.mockResolvedValueOnce(null);
    expect((await GET(new Request(url), context)).status).toBe(401);
    mocks.resolve.mockResolvedValueOnce({
      ...identity,
      user: { ...identity.user, status: "disabled" },
    });
    expect((await GET(new Request(url), context)).status).toBe(401);
    mocks.permission.mockImplementationOnce(() => {
      throw new DomainError("AUTH_FORBIDDEN", "权限已撤销");
    });
    expect((await GET(new Request(url), context)).status).toBe(403);
    expect((await GET(new Request(url + "x"), context)).status).toBe(401);
    const other = "019a25a1-0000-7000-8000-000000000003";
    expect(
      (
        await GET(new Request(url.replace(archiveId, other)), {
          params: Promise.resolve({ archiveId: other }),
        })
      ).status,
    ).toBe(401);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("rejects changed file checksums and removed copies before opening storage", async () => {
    const url = await link();
    const original = await mocks.find();
    mocks.find.mockResolvedValue({ ...original, sha256: "b".repeat(64) });
    expect((await GET(new Request(url), context)).status).toBe(401);
    mocks.find.mockResolvedValue({ ...original, copyState: "deleted" });
    expect((await GET(new Request(url), context)).status).toBe(410);
    expect((await POST(request())).status).toBe(410);
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
