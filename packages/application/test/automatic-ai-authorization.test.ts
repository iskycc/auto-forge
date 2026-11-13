import { describe, expect, it, vi } from "vitest";
import { AiAnalysisService, resolveAiActor } from "../src/ai-analysis";
import { resolveAutomaticAiAuthority } from "../src/automatic-ai-authorization";
import type { AiAnalysisRepository } from "../src/ai-analysis-ports";
import type { IdentityAccessRepository, RunBatchRepository, SecretCipherPort } from "../src/ports";
import type { Permission } from "@autoforge/domain";

const permissions: Permission[] = ["analysis.ai.create", "run.read", "case.read", "log.read"];
const publisher = { id: "publisher", username: "original-publisher", source: "local" as const };
const initiator = { id: "visitor", username: "visitor", source: "local" as const };

function fixture() {
  const findUser = vi.fn<IdentityAccessRepository["findUser"]>(async (id: string) => ({
    ...(id === publisher.id ? publisher : initiator),
    username: id === publisher.id ? "renamed-publisher" : initiator.username,
    status: "active",
    displayName: id,
    forcePasswordChange: false,
    failedLoginAttempts: 0,
    createdAt: "2026-11-13T00:00:00Z",
    updatedAt: "2026-11-13T00:00:00Z",
    version: 1,
  }));
  const findUserByUsername = vi.fn(async () => ({ user: { id: initiator.id } }));
  const listSystemRoleBindings = vi.fn(async (ids: string[]) =>
    ids.includes(publisher.id) ? [{ roleId: "ai-role" }] : [],
  );
  const identities = {
    findUser,
    findUserByUsername,
    listSystemRoleBindings,
    listRoles: async () => [{ id: "ai-role", active: true, permissions }],
    listUserProjectRoleBindings: async () => [],
  } as unknown as IdentityAccessRepository;
  const snapshot = {
    id: "batch",
    projectId: "project",
    status: "failed",
    retryLimit: 0,
    retryMode: "round",
    currentRound: 1,
    policy: { aiAnalysisAfterCompletion: true, aiAnalysisExecutionId: "batch" },
    requestedBy: { username: initiator.username, source: initiator.source },
    publicExecution: { publisher, initiator },
  };
  const batches = { getMetadata: vi.fn(async () => snapshot) } as unknown as Pick<
    RunBatchRepository,
    "getMetadata"
  >;
  const create = vi.fn(async (job) => job);
  const service = new AiAnalysisService(
    {
      configuration: async () => ({ configuration: { enabled: true } }),
      create,
    } as unknown as AiAnalysisRepository,
    batches as RunBatchRepository,
    {} as SecretCipherPort,
    { now: () => new Date("2026-11-13T00:00:00Z") },
    { next: () => "job" },
  );
  return {
    identities,
    batches,
    findUser,
    findUserByUsername,
    listSystemRoleBindings,
    snapshot,
    service,
    create,
  };
}

describe("automatic AI disclosure authority", () => {
  it("uses the public publisher's immutable ID and current grants when the initiator has no AI permissions", async () => {
    const f = fixture();
    const authority = await resolveAutomaticAiAuthority(f.identities, f.batches, "batch");
    expect(authority.actorLabel).toBe("公开链接分享人");
    expect(authority.actor?.user.id).toBe(publisher.id);
    expect(f.findUserByUsername).not.toHaveBeenCalled();
    await expect(f.service.createAutomatic(authority.actor!, "batch")).resolves.toMatchObject({
      requestedBy: publisher.id,
    });
    expect(f.snapshot.requestedBy.username).toBe(initiator.username);
    expect(f.snapshot.publicExecution.initiator).toEqual(initiator);
    await expect(
      f.service.create(authority.actor!, { batchId: "batch", requestKey: "manual-publisher" }),
    ).resolves.toMatchObject({ requestedBy: publisher.id });
  });
  it("does not borrow the initiator's grants when the publisher's permissions are revoked", async () => {
    const f = fixture();
    f.listSystemRoleBindings.mockImplementation(async (ids) =>
      ids.includes(initiator.id) ? [{ roleId: "ai-role" }] : [],
    );
    const authority = await resolveAutomaticAiAuthority(f.identities, f.batches, "batch");
    expect(authority.actor).toBeNull();
    expect(authority.unavailableReason).toContain("分享人缺少当前 AI 或证据权限");
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each(["disabled", "deleted"])(
    "does not fall back to the visitor when the publisher is %s",
    async (state) => {
      const f = fixture();
      if (state === "disabled") {
        const original = await f.findUser(publisher.id);
        f.findUser.mockResolvedValue({ ...original!, status: "disabled" });
      } else f.findUser.mockResolvedValue(null);
      const authority = await resolveAutomaticAiAuthority(f.identities, f.batches, "batch");
      expect(authority.actor).toBeNull();
      expect(authority.unavailableReason).toContain("分享");
      expect(f.findUserByUsername).not.toHaveBeenCalled();
    },
  );
  it("keeps normal execution and manual analysis on the real initiator's permissions", async () => {
    const f = fixture();
    Reflect.deleteProperty(f.snapshot, "publicExecution");
    const authority = await resolveAutomaticAiAuthority(f.identities, f.batches, "batch");
    expect(authority.actorLabel).toBe("执行拉起人");
    expect(authority.actor).toBeNull();
    expect(authority.unavailableReason).toContain("执行拉起人缺少当前 AI 或证据权限");
    expect(f.findUserByUsername).toHaveBeenCalledWith("visitor");
  });
  it("continues to authorize normal automatic execution with the initiator's current grants", async () => {
    const f = fixture();
    Reflect.deleteProperty(f.snapshot, "publicExecution");
    f.listSystemRoleBindings.mockImplementation(async (ids) =>
      ids.includes(initiator.id) ? [{ roleId: "ai-role" }] : [],
    );
    const authority = await resolveAutomaticAiAuthority(f.identities, f.batches, "batch");
    expect(authority.actor?.user.id).toBe(initiator.id);
    await expect(f.service.createAutomatic(authority.actor!, "batch")).resolves.toMatchObject({
      requestedBy: initiator.id,
    });
  });

  it("does not require an initiator account snapshot for a published execution", async () => {
    const f = fixture();
    Reflect.deleteProperty(f.snapshot, "requestedBy");
    expect(
      (await resolveAutomaticAiAuthority(f.identities, f.batches, "batch")).actor?.user.id,
    ).toBe(publisher.id);
    expect(f.findUserByUsername).not.toHaveBeenCalled();
  });
  it("does not delegate an explicitly requested manual analysis to the publisher", async () => {
    const f = fixture();
    const visitor = await resolveAiActor(f.identities, initiator.id);
    await expect(
      f.service.create(visitor!, { batchId: "batch", requestKey: "manual-visitor" }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("preserves ordinary legacy batches that stored only the initiator username", async () => {
    const f = fixture();
    Reflect.deleteProperty(f.snapshot, "publicExecution");
    Reflect.deleteProperty(f.snapshot, "requestedBy");
    f.listSystemRoleBindings.mockImplementation(async (ids) =>
      ids.includes(initiator.id) ? [{ roleId: "ai-role" }] : [],
    );
    const authority = await resolveAutomaticAiAuthority(
      f.identities,
      f.batches,
      "batch",
      " Visitor ",
    );
    expect(authority.actor?.user.id).toBe(initiator.id);
    expect(f.findUserByUsername).toHaveBeenCalledWith("visitor");
  });
});
