import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
vi.mock("server-only", () => ({}));
import { sharedLogAccess } from "./shared-attempt-log-access";
type Services = Parameters<typeof sharedLogAccess>[0];
type Identity = NonNullable<Parameters<typeof sharedLogAccess>[1]>;
const authorize = vi.fn();
const getAttemptRerunContext = vi.fn();
const services = {
  identityAccess: { authorize },
  runBatches: { getAttemptRerunContext },
} as unknown as Services;
const identity = { user: { id: "reader", forcePasswordChange: false } } as Identity;
beforeEach(() => {
  vi.resetAllMocks();
  getAttemptRerunContext.mockResolvedValue({ projectId: "project" });
});
describe("log detail control permissions", () => {
  it("keeps anonymous visitors static and without stop controls", async () => {
    expect(await sharedLogAccess(services, null, "attempt")).toEqual({
      rerunAccess: "login",
      canCancelRuns: false,
      canReadCaseDetails: false,
    });
    expect(getAttemptRerunContext).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "treats stop permission independently of retry permission (stop=%s)",
    async (canStop) => {
      authorize.mockImplementation((_identity, permission) => {
        if (permission === "run.retry" || (permission === "run.cancel" && !canStop))
          throw new DomainError("AUTH_FORBIDDEN", "denied");
      });
      expect(await sharedLogAccess(services, identity, "attempt")).toEqual({
        rerunAccess: "read_only",
        canCancelRuns: canStop,
        canReadCaseDetails: true,
      });
    },
  );
  it("hides both controls when project log access is denied", async () => {
    authorize.mockImplementation(() => {
      throw new DomainError("AUTH_FORBIDDEN", "wrong project");
    });
    expect(await sharedLogAccess(services, identity, "attempt")).toEqual({
      rerunAccess: "forbidden",
      canCancelRuns: false,
      canReadCaseDetails: false,
    });
  });
  it("does not grant case access through public log, retry or stop permissions", async () => {
    authorize.mockImplementation((_identity, permission, projectId) => {
      expect(projectId).toBe("project");
      if (permission === "case.read") throw new DomainError("AUTH_FORBIDDEN", "denied");
    });
    expect(await sharedLogAccess(services, identity, "attempt")).toEqual({
      rerunAccess: "allowed",
      canCancelRuns: true,
      canReadCaseDetails: false,
    });
  });
  it("permits case navigation independently of authenticated log controls", async () => {
    authorize.mockImplementation((_identity, permission) => {
      if (permission !== "case.read") throw new DomainError("AUTH_FORBIDDEN", "denied");
    });
    expect(await sharedLogAccess(services, identity, "attempt")).toEqual({
      rerunAccess: "forbidden",
      canCancelRuns: false,
      canReadCaseDetails: true,
    });
  });
  it("preserves infrastructure failures rather than treating them as denied permission", async () => {
    getAttemptRerunContext.mockRejectedValue(new Error("database unavailable"));
    await expect(sharedLogAccess(services, identity, "attempt")).rejects.toThrow(
      "database unavailable",
    );
  });
  it("requires the initial password change before enabling case navigation", async () => {
    const restricted = { ...identity, user: { ...identity.user, forcePasswordChange: true } };
    expect(await sharedLogAccess(services, restricted, "attempt")).toEqual({
      rerunAccess: "forbidden",
      canCancelRuns: false,
      canReadCaseDetails: false,
    });
    expect(getAttemptRerunContext).not.toHaveBeenCalled();
  });
});
