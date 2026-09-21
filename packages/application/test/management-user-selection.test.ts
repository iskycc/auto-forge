import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedIdentity, Role } from "@autoforge/domain";
import { IdentityAccessService } from "../src/manage-identity-access";

const timestamp = "2026-09-22T00:00:00.000Z";
const actor: AuthenticatedIdentity = {
  user: {
    id: "administrator",
    username: "admin",
    displayName: "Admin",
    version: 1,
    source: "local",
    status: "active",
    forcePasswordChange: false,
    failedLoginAttempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  sessionId: "current",
  systemPermissions: ["role.manage", "user.manage"],
  projectPermissions: { project: ["project.manage"] },
};
function fixture() {
  const role = (id: string): Role => ({
    id,
    key: id,
    name: id,
    description: "",
    scope: id.startsWith("project") ? "project" : "system",
    permissions: [],
    active: true,
    builtIn: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const repository = {
    listUsers: vi.fn(async () => ({
      items: [{ ...actor.user, email: "private@example.test", passwordHash: "secret" }],
      nextCursor: "next",
    })),
    listProjectMemberships: vi.fn(async () => [{ user: actor.user, roleIds: ["project-role"] }]),
    findUser: vi.fn(async () => actor.user),
    findRole: vi.fn(async (id: string) => role(id)),
    assignSystemRole: vi.fn(async () => undefined),
    assignProjectRole: vi.fn(async () => undefined),
    revokeUserSessions: vi.fn(async () => undefined),
    appendAudit: vi.fn(async () => undefined),
  };
  type Dependencies = ConstructorParameters<typeof IdentityAccessService>;
  const service = new IdentityAccessService(
    repository as unknown as Dependencies[0],
    {} as Dependencies[1],
    {} as Dependencies[2],
    {} as Dependencies[3],
    {} as Dependencies[4],
    { now: () => new Date(timestamp) },
    { next: () => "audit" },
    8,
  );
  return { service, repository };
}
describe("management user selection", () => {
  it("authorizes the operation before searching and returns only candidate fields", async () => {
    const { service, repository } = fixture();
    const candidates = await service.listUserCandidates(actor, {
      purpose: "project-member",
      projectId: "project",
      query: "admin",
      cursor: "previous",
      limit: 500,
    });
    expect(repository.listUsers).toHaveBeenCalledWith({
      query: "admin",
      cursor: "previous",
      limit: 50,
    });
    expect(candidates).toEqual({
      items: [
        {
          id: "administrator",
          username: "admin",
          displayName: "Admin",
          source: "local",
          status: "active",
        },
      ],
      nextCursor: "next",
    });
    repository.listUsers.mockClear();
    await expect(
      service.listUserCandidates(actor, {
        purpose: "project-member",
        projectId: "other",
        limit: 25,
      }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(repository.listUsers).not.toHaveBeenCalled();
  });
  it("restricts owner candidates to project members without requiring global user read", async () => {
    const { service, repository } = fixture();
    await service.listUserCandidates(actor, {
      purpose: "project-owner",
      projectId: "project",
      query: "admin",
      limit: 25,
    });
    expect(repository.listProjectMemberships).toHaveBeenCalledWith("project", {
      query: "admin",
      limit: 26,
    });
    expect(repository.listUsers).not.toHaveBeenCalled();
    await service.listUserCandidates(actor, { purpose: "password", limit: 25 });
    expect(repository.listUsers).toHaveBeenCalledWith({ source: "local", limit: 25 });
  });
  it("validates all roles before changing bindings and deduplicates a selection", async () => {
    const { service, repository } = fixture();
    await expect(
      service.assignRoleSelection(actor, {
        userIds: ["user"],
        roleIds: ["system-one", "project-one"],
      }),
    ).rejects.toMatchObject({ code: "ROLE_SCOPE_INVALID" });
    expect(repository.assignSystemRole).not.toHaveBeenCalled();
    await expect(
      service.assignRoleSelection(actor, {
        userIds: [actor.user.id, actor.user.id],
        roleIds: ["system-one", "system-two", "system-one"],
      }),
    ).resolves.toEqual({ assigned: 2 });
    expect(repository.assignSystemRole).toHaveBeenCalledTimes(2);
    expect(repository.revokeUserSessions).toHaveBeenCalledTimes(2);
  });
  it("reports completed bindings after a storage failure without retrying indefinitely", async () => {
    const { service, repository } = fixture();
    repository.assignSystemRole
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("busy"));
    await expect(
      service.assignRoleSelection(actor, { userIds: ["user"], roleIds: ["one", "two"] }),
    ).rejects.toMatchObject({
      code: "ROLE_ASSIGNMENT_PARTIAL",
      details: { completed: [{ userId: "user", roleId: "one" }] },
    });
    expect(repository.assignSystemRole).toHaveBeenCalledTimes(2);
  });
});
