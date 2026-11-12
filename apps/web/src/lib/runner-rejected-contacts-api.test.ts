import { beforeEach, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
vi.mock("server-only", () => ({}));
const calls = vi.hoisted(() => ({ authorize: vi.fn(), list: vi.fn() }));
vi.mock("./auth", () => ({ authorizeRequest: calls.authorize }));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({ deletedRunnerContacts: { list: calls.list } }),
}));
import { GET } from "../app/api/v1/runners/rejected-contacts/route";
beforeEach(() => {
  vi.resetAllMocks();
  calls.list.mockResolvedValue({ items: [] });
});
it("requires Runner management rather than allowing anonymous or read-only lookup", async () => {
  calls.authorize.mockRejectedValue(new DomainError("AUTH_REQUIRED", "请登录"));
  expect((await GET(new Request("http://localhost/api/v1/runners/rejected-contacts"))).status).toBe(
    401,
  );
  expect(calls.list).not.toHaveBeenCalled();
});
it("uses bounded cursor queries and disables response caching", async () => {
  const cursor = "00000000-0000-7000-8000-000000000001";
  const response = await GET(
    new Request(`http://localhost/api/v1/runners/rejected-contacts?limit=10&cursor=${cursor}`),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(calls.list).toHaveBeenCalledWith({ limit: 10, afterId: cursor });
  expect(
    (await GET(new Request("http://localhost/api/v1/runners/rejected-contacts?limit=100000")))
      .status,
  ).toBe(400);
});
