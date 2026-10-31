import { beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const calls = vi.hoisted(() => ({ create: vi.fn(), audit: vi.fn(), authorize: vi.fn() }));
vi.mock("./auth", () => ({
  authenticateRequest: async () => ({
    user: {
      id: "launcher-id",
      displayName: "操作人",
      username: "launcher",
      source: "local",
    },
  }),
  requestId: () => "create-request",
  requireSameOrigin: () => {},
}));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    caseSuites: { getSummary: async () => ({ id: "suite", projectId: "project" }) },
    identityAccess: {
      projectScope: () => ["project"],
      authorize: calls.authorize,
      recordAuthorizedOperation: calls.audit,
    },
    runBatches: { create: calls.create },
  }),
}));
import { POST } from "../app/api/v1/run-batches/route";

beforeEach(() => vi.resetAllMocks());

it("rejects caller-supplied audit identities before creating an execution", async () => {
  const response = await POST(
    new Request("http://localhost/api/v1/run-batches", {
      method: "POST",
      body: JSON.stringify({ suiteId: "suite", creationAudit: { actorId: "another-user" } }),
    }),
  );
  expect(response.status).toBe(400);
  expect(calls.create).not.toHaveBeenCalled();
});

it("passes the audit into creation and performs no database writes after acceptance", async () => {
  calls.create.mockResolvedValue({ id: "batch", projectId: "project", status: "queued" });
  calls.audit.mockRejectedValue(
    Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
  );
  const response = await POST(
    new Request("http://localhost/api/v1/run-batches", {
      method: "POST",
      body: JSON.stringify({ suiteId: "suite" }),
    }),
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ id: "batch", status: "queued" });
  expect(calls.create).toHaveBeenCalledWith(
    { suiteId: "suite", delaySeconds: 0 },
    { username: "launcher", source: "local" },
    undefined,
    { actorId: "launcher-id", actorName: "操作人 · launcher", requestId: "create-request" },
  );
  expect(calls.audit).not.toHaveBeenCalled();
});

it("returns a database error when the creation transaction does not commit", async () => {
  calls.create.mockRejectedValue(
    Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
  );
  const response = await POST(
    new Request("http://localhost/api/v1/run-batches", {
      method: "POST",
      body: JSON.stringify({ suiteId: "suite" }),
    }),
  );
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("PLATFORM_BUSY");
  expect(calls.audit).not.toHaveBeenCalled();
});
