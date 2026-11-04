import { describe, it, expect, vi } from "vitest";
import type { AuthenticatedIdentity, Permission } from "@autoforge/domain";
import type { IdentityAccessRepository } from "../src/ports";
import { assertAiPermission, resolveAiActor } from "../src/ai-analysis";
import { aiModelConfigurationSchema } from "@autoforge/contracts";
import type { AiAnalysisRepository, AiGroupWork } from "../src/ai-analysis-ports";
import { AiAnalysisWorker, type AiEvidencePort } from "../src/ai-analysis-worker";
import type { SecretCipherPort } from "../src/ports";

function actor(permissions: Permission[]): AuthenticatedIdentity {
  return {
    user: {
      id: "actor",
      username: "actor",
      displayName: "Actor",
      source: "local",
      status: "active",
      forcePasswordChange: false,
      failedLoginAttempts: 0,
      createdAt: "2026-11-04T00:00:00Z",
      updatedAt: "2026-11-04T00:00:00Z",
      version: 1,
    },
    sessionId: "test",
    systemPermissions: [],
    projectPermissions: { project: permissions },
  };
}
describe("AI evidence authorization", () => {
  it("keeps manual analysis permissions separate from model disclosure", () => {
    expect(() =>
      assertAiPermission(
        actor(["run.read", "case.read", "log.read", "analysis.manage"]),
        "project",
        true,
      ),
    ).toThrow();
  });
  it("requires both the explicit AI capability and all evidence permissions", () => {
    expect(() =>
      assertAiPermission(actor(["analysis.ai.create", "run.read", "case.read"]), "project", true),
    ).toThrow();
    expect(() =>
      assertAiPermission(
        actor(["analysis.ai.create", "run.read", "case.read", "log.read"]),
        "project",
        true,
      ),
    ).not.toThrow();
  });
  it("does not reuse one project's permission in another project", () => {
    expect(() =>
      assertAiPermission(
        actor(["analysis.ai.read", "run.read", "case.read", "log.read"]),
        "another-project",
      ),
    ).toThrow();
  });
  it("stops a disabled requester before reading role grants", async () => {
    const readRoles = vi.fn();
    const repository = {
      findUser: async () => ({ ...actor([]).user, status: "disabled" as const }),
      listRoles: readRoles,
    } as unknown as IdentityAccessRepository;
    expect(await resolveAiActor(repository, "actor")).toBeNull();
    expect(readRoles).not.toHaveBeenCalled();
  });
});

function groupWorker() {
  const now = new Date("2026-11-04T00:00:00.000Z");
  const work: AiGroupWork = {
    id: "group",
    jobId: "job",
    batchId: "batch",
    projectId: "project",
    requestedBy: "actor",
    leaseToken: "lease",
    cursor: "",
    signature: "stack",
    conclusion: null,
    attempts: 0,
    processed: 0,
    memberCount: 2,
  };
  const configuration = aiModelConfigurationSchema.parse({
    enabled: true,
    baseUrl: "http://model/v1",
    modelId: "test",
    tokensPerMinute: 100000,
  });
  const groupMembers = vi
    .fn()
    .mockResolvedValue([
      { id: "member", displayName: "case", conclusion: "初步建议", reason: null },
    ]);
  const deferGroup = vi.fn();
  const reserveModel = vi.fn();
  const repository = {
    configuration: async () => ({ revision: 1, configuration, encryptedKey: null }),
    claimPlanning: async () => null,
    claimWork: async () => null,
    prepareGroups: async () => {},
    claimGroup: async () => work,
    groupMembers,
    deferGroup,
    reserveModel,
  } as unknown as AiAnalysisRepository;
  const identities = {
    findUser: async () => actor([]).user,
    listRoles: async () => [
      {
        id: "role",
        active: true,
        permissions: ["analysis.ai.create", "run.read", "case.read", "log.read"],
      },
    ],
    listSystemRoleBindings: async () => [{ roleId: "role" }],
    listUserProjectRoleBindings: async () => [],
  } as unknown as IdentityAccessRepository;
  const canWork = vi.fn().mockReturnValue(true);
  const complete = vi.fn();
  const busy = new Error("database busy");
  const worker = new AiAnalysisWorker(
    repository,
    {} as AiEvidencePort,
    { complete },
    identities,
    {} as SecretCipherPort,
    { now: () => now },
    { next: () => "token" },
    canWork,
    vi.fn(),
    undefined,
    (error) => error === busy,
  );
  return { worker, groupMembers, deferGroup, reserveModel, complete, canWork, busy, configuration };
}

describe("AI group reduction admission", () => {
  it("defers without charging a retry when platform pressure rises before inference", async () => {
    const fixture = groupWorker();
    fixture.canWork.mockReturnValueOnce(true).mockReturnValue(false);
    expect(await fixture.worker.tick(new AbortController().signal)).toBe(true);
    expect(fixture.reserveModel).not.toHaveBeenCalled();
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.deferGroup).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("退避"),
      expect.any(String),
      false,
      expect.any(String),
      false,
    );
  });
  it("reports an impossible per-request TPM budget instead of waiting indefinitely", async () => {
    const fixture = groupWorker();
    fixture.configuration.tokensPerMinute = 4096;
    fixture.groupMembers.mockResolvedValue([{ id: "member", conclusion: "x".repeat(6000) }]);
    await fixture.worker.tick(new AbortController().signal);
    expect(fixture.reserveModel).not.toHaveBeenCalled();
    expect(fixture.deferGroup).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("TPM"),
      expect.any(String),
      true,
      expect.any(String),
    );
  });
  it("treats temporary database contention as a resource wait", async () => {
    const fixture = groupWorker();
    fixture.groupMembers.mockRejectedValue(fixture.busy);
    await fixture.worker.tick(new AbortController().signal);
    expect(fixture.deferGroup).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("退避"),
      expect.any(String),
      false,
      expect.any(String),
      false,
    );
  });
});
