import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";

vi.mock("server-only", () => ({}));
const runtime = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authorize: vi.fn(),
  origin: vi.fn(),
  context: vi.fn(),
  cancel: vi.fn(),
  audit: vi.fn(),
  logs: vi.fn(),
}));
vi.mock("./auth", () => ({
  authenticateRequest: runtime.authenticate,
  requestId: () => "manual-request",
  requireSameOrigin: runtime.origin,
}));
vi.mock("./services", () => ({
  getPlatformServices: async () => ({
    runBatches: { getManualAttemptContext: runtime.context },
    executionControl: { cancelRun: runtime.cancel, listLogs: runtime.logs },
    clock: { now: () => new Date("2026-10-10T00:00:00.000Z") },
    config: { terminalAccessToken: "manual-log-ticket-secret-that-is-longer-than-32-bytes" },
    identityAccess: {
      authorize: runtime.authorize,
      projectScope: () => ["project"],
      recordAuthorizedOperation: runtime.audit,
    },
  }),
}));
import { GET } from "../app/api/v1/run-attempts/[attemptId]/manual-state/route";
import { POST } from "../app/api/v1/run-attempts/[attemptId]/cancel/route";
import { POST as streamTicket } from "../app/api/v1/run-attempts/[attemptId]/log-stream-ticket/route";
const context = { params: Promise.resolve({ attemptId: "attempt" }) };
function stopRequest() {
  return new Request("http://localhost/api/v1/run-attempts/attempt/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "operator forced stop" }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  runtime.authenticate.mockResolvedValue({ user: { id: "operator" } });
  runtime.context.mockResolvedValue({
    projectId: "project",
    executionRunId: "manual-run",
    status: "running",
  });
});
describe("manual log controls API", () => {
  it("stops only the resolved manual execution and records its operator", async () => {
    expect((await POST(stopRequest(), context)).status).toBe(200);
    expect(runtime.authorize).toHaveBeenCalledWith(expect.anything(), "log.read", "project");
    expect(runtime.authorize).toHaveBeenCalledWith(expect.anything(), "run.cancel", "project");
    expect(runtime.cancel).toHaveBeenCalledWith("operator", "manual-run", "operator forced stop", [
      "project",
    ]);
    expect(runtime.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "run_attempt.manual_cancel", resourceId: "attempt" }),
    );
  });
  it("does not change a completed attempt or produce a cancellation audit", async () => {
    runtime.context.mockResolvedValue({ projectId: "project", status: "succeeded" });
    const response = await POST(stopRequest(), context);
    expect(await response.json()).toMatchObject({ cancelled: false, status: "succeeded" });
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(runtime.audit).not.toHaveBeenCalled();
  });
  it("rejects task attempts before calling cancellation", async () => {
    runtime.context.mockRejectedValue(new DomainError("MANUAL_EXECUTION_REQUIRED", "manual only"));
    expect((await POST(stopRequest(), context)).status).toBe(400);
    expect(runtime.cancel).not.toHaveBeenCalled();
  });
  it("requires stop permission even when the operator can read logs", async () => {
    runtime.authorize.mockImplementation((_identity, permission) => {
      if (permission === "run.cancel") throw new DomainError("AUTH_FORBIDDEN", "not allowed");
    });
    expect((await POST(stopRequest(), context)).status).toBe(403);
    expect(runtime.cancel).not.toHaveBeenCalled();
  });
  it("rejects anonymous and cross-origin stop requests", async () => {
    runtime.authenticate.mockRejectedValue(new DomainError("AUTH_REQUIRED", "login required"));
    expect((await POST(stopRequest(), context)).status).toBe(401);
    runtime.origin.mockImplementation(() => {
      throw new DomainError("AUTH_FORBIDDEN", "origin rejected");
    });
    expect((await POST(stopRequest(), context)).status).toBe(403);
    expect(runtime.cancel).not.toHaveBeenCalled();
  });
  it("reads a minimal state under project log permission", async () => {
    const response = await GET(new Request("http://localhost/manual-state"), context);
    expect(await response.json()).toEqual({ attemptId: "attempt", status: "running" });
    expect(runtime.authorize).toHaveBeenCalledWith(expect.anything(), "log.read", "project");
  });
  it("does not expose state to users without project log access", async () => {
    runtime.authorize.mockImplementation(() => {
      throw new DomainError("AUTH_FORBIDDEN", "wrong project");
    });
    expect((await GET(new Request("http://localhost/manual-state"), context)).status).toBe(403);
  });
  it("issues detail tickets only after verifying manual source and project permission", async () => {
    const response = await streamTicket(
      new Request("http://localhost/ticket?manualOnly=1", { method: "POST" }),
      context,
    );
    expect(response.status).toBe(200);
    expect(runtime.context).toHaveBeenCalledWith("attempt");
    expect(runtime.authorize).toHaveBeenCalledWith(expect.anything(), "log.read", "project");
    expect(runtime.logs).not.toHaveBeenCalled();
  });
  it("rejects task and completed attempts on the manual detail ticket path", async () => {
    runtime.context.mockRejectedValueOnce(
      new DomainError("MANUAL_EXECUTION_REQUIRED", "task attempt"),
    );
    expect(
      (
        await streamTicket(
          new Request("http://localhost/ticket?manualOnly=1", { method: "POST" }),
          context,
        )
      ).status,
    ).toBe(400);
    runtime.context.mockResolvedValue({ projectId: "project", status: "succeeded" });
    expect(
      (
        await streamTicket(
          new Request("http://localhost/ticket?manualOnly=1", { method: "POST" }),
          context,
        )
      ).status,
    ).toBe(400);
  });
  it("preserves the existing floating log ticket and its persisted permission check", async () => {
    expect(
      (await streamTicket(new Request("http://localhost/ticket", { method: "POST" }), context))
        .status,
    ).toBe(200);
    expect(runtime.context).not.toHaveBeenCalled();
    expect(runtime.logs).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "attempt", limit: 1, projectIds: ["project"] }),
    );
  });
});
