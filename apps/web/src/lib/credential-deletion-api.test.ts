import { beforeEach, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  origin: vi.fn(),
  account: vi.fn(),
  token: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("./auth", () => ({
  authenticateRequest: mocks.authenticate,
  requireSameOrigin: mocks.origin,
  requestId: () => "delete-request",
}));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    platformOperations: { deleteServiceAccount: mocks.account, deleteApiToken: mocks.token },
    identityAccess: { recordAuthorizedOperation: mocks.audit },
  }),
}));
import { DELETE as deleteAccount } from "../app/api/v1/service-accounts/[accountId]/route";
import { DELETE as deleteToken } from "../app/api/v1/api-tokens/[tokenId]/route";
const request = () =>
  new Request("http://localhost/credentials", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 2 }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ user: { id: "admin" } });
  mocks.account.mockResolvedValue({ id: "account", name: "CI" });
  mocks.token.mockResolvedValue({ id: "token", name: "CI", serviceAccountId: "account" });
});
it("rejects cross-origin and unauthorized requests before changing credentials", async () => {
  mocks.origin.mockImplementationOnce(() => {
    throw new DomainError("AUTH_FORBIDDEN", "来源不合法");
  });
  expect(
    (await deleteToken(request(), { params: Promise.resolve({ tokenId: "token" }) })).status,
  ).toBe(403);
  expect(mocks.token).not.toHaveBeenCalled();
  mocks.authenticate.mockRejectedValueOnce(new DomainError("AUTH_REQUIRED", "请登录"));
  expect(
    (await deleteAccount(request(), { params: Promise.resolve({ accountId: "account" }) })).status,
  ).toBe(401);
  expect(mocks.account).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
});
it("records separate deletion audits without secrets", async () => {
  expect(
    (await deleteAccount(request(), { params: Promise.resolve({ accountId: "account" }) })).status,
  ).toBe(200);
  expect(mocks.account).toHaveBeenCalledWith(expect.any(Object), "account", {
    expectedRevision: 2,
  });
  expect(
    (await deleteToken(request(), { params: Promise.resolve({ tokenId: "token" }) })).status,
  ).toBe(200);
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.any(Object),
    expect.objectContaining({
      action: "service_account.delete",
      resourceId: "account",
      details: { name: "CI" },
    }),
  );
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.any(Object),
    expect.objectContaining({
      action: "api_token.delete",
      details: { name: "CI", serviceAccountId: "account" },
    }),
  );
});
it("returns actionable conflicts and request identifiers without recording a successful deletion", async () => {
  mocks.token.mockRejectedValueOnce(
    new DomainError("API_TOKEN_DELETE_CONFLICT", "请先撤销仍有效的 API 令牌"),
  );
  const response = await deleteToken(request(), { params: Promise.resolve({ tokenId: "token" }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { code: "API_TOKEN_DELETE_CONFLICT", requestId: "delete-request" },
  });
  expect(mocks.audit).not.toHaveBeenCalled();
});
