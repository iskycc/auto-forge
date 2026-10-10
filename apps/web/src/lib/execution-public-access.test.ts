import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";

vi.mock("server-only", () => ({}));
const { authenticateRequest } = vi.hoisted(() => ({ authenticateRequest: vi.fn() }));
vi.mock("./auth", () => ({ authenticateRequest }));
import { executionReadProjectScope } from "./execution-public-access";
import { issuePermanentShareToken } from "./permanent-share-token";

const services = {
  config: { masterKey: "a".repeat(64) },
  identityAccess: { projectScope: vi.fn() },
  publicExecutionAccess: { isBatchPublic: vi.fn() },
};
const request = new Request("http://localhost/api/v1/run-batches/batch-1/cases");
beforeEach(() => {
  vi.resetAllMocks();
  services.identityAccess.projectScope.mockReturnValue(["project-1"]);
});

describe("execution public read boundary", () => {
  it("allows a published batch's read-only APIs without a session", async () => {
    services.publicExecutionAccess.isBatchPublic.mockResolvedValue(true);
    expect(
      await executionReadProjectScope(request, "batch-1", { publicAccess: true }, services),
    ).toBeUndefined();
    expect(services.publicExecutionAccess.isBatchPublic).toHaveBeenCalledWith("batch-1");
    expect(authenticateRequest).not.toHaveBeenCalled();
  });
  it("rejects unpublished IDs even when public access is requested", async () => {
    services.publicExecutionAccess.isBatchPublic.mockResolvedValue(false);
    await expect(
      executionReadProjectScope(request, "batch-1", { publicAccess: true }, services),
    ).rejects.toMatchObject({ code: "RUN_BATCH_SHARE_TOKEN_INVALID" });
    expect(authenticateRequest).not.toHaveBeenCalled();
  });
  it("keeps valid legacy batch signatures readable without requiring new grants", async () => {
    const accessToken = issuePermanentShareToken(services.config.masterKey, "run_batch", "batch-1");
    expect(
      await executionReadProjectScope(request, "batch-1", { accessToken }, services),
    ).toBeUndefined();
    expect(services.publicExecutionAccess.isBatchPublic).not.toHaveBeenCalled();
  });
  it("does not accept another batch's signature or fall back to a public grant", async () => {
    const accessToken = issuePermanentShareToken(services.config.masterKey, "run_batch", "batch-2");
    await expect(
      executionReadProjectScope(request, "batch-1", { accessToken, publicAccess: true }, services),
    ).rejects.toMatchObject({ code: "RUN_BATCH_SHARE_TOKEN_INVALID" });
    expect(services.publicExecutionAccess.isBatchPublic).not.toHaveBeenCalled();
  });
  it("keeps console reads scoped to the authenticated user's projects", async () => {
    const identity = { user: { id: "reader" } };
    authenticateRequest.mockResolvedValue(identity);
    expect(await executionReadProjectScope(request, "batch-1", {}, services)).toEqual([
      "project-1",
    ]);
    expect(services.identityAccess.projectScope).toHaveBeenCalledWith(identity, "run.read");
  });
  it("does not turn console requests into anonymous reads merely because a batch was published", async () => {
    services.publicExecutionAccess.isBatchPublic.mockResolvedValue(true);
    authenticateRequest.mockRejectedValue(new DomainError("AUTHENTICATION_REQUIRED", "请登录。"));
    await expect(executionReadProjectScope(request, "batch-1", {}, services)).rejects.toMatchObject(
      { code: "AUTHENTICATION_REQUIRED" },
    );
    expect(services.publicExecutionAccess.isBatchPublic).not.toHaveBeenCalled();
  });
});
