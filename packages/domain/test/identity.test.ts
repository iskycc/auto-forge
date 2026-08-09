import {
  builtInRoleDefinitions,
  DEFAULT_PROJECT_ID,
  hasPermission,
  permissionCatalog,
  type AuthenticatedIdentity,
  type Permission,
  type User,
} from "../src";
import { describe, expect, it } from "vitest";

describe("identity permissions", () => {
  it("keeps the built-in role catalog stable and grants every permission only to system administrators", () => {
    expect(builtInRoleDefinitions.map((role) => role.key)).toEqual([
      "system-admin",
      "project-admin",
      "test-manager",
      "execution-operator",
      "viewer",
      "auditor",
    ]);
    expect(role("system-admin").permissions).toEqual(permissionCatalog);
    for (const restrictedRole of builtInRoleDefinitions.filter(
      (definition) => definition.key !== "system-admin",
    )) {
      expect(restrictedRole.permissions).not.toContain("user.manage");
      expect(restrictedRole.permissions).not.toContain("ldap.manage");
      expect(restrictedRole.permissions).not.toContain("settings.manage");
    }
  });

  it("keeps terminal access separate from ordinary execution permission", () => {
    expect(role("project-admin").permissions).toContain("runner.terminal");
    for (const roleKey of ["test-manager", "execution-operator", "viewer", "auditor"]) {
      expect(role(roleKey).permissions).not.toContain("runner.terminal");
    }
  });

  it("defaults to deny and never leaks a project grant into another project", () => {
    const viewer = identity([], { [DEFAULT_PROJECT_ID]: role("viewer").permissions });
    expect(hasPermission(viewer, "case.read", DEFAULT_PROJECT_ID)).toBe(true);
    expect(hasPermission(viewer, "case.read", "another-project")).toBe(false);
    expect(hasPermission(viewer, "case.read")).toBe(false);
    expect(hasPermission(viewer, "case.manage", DEFAULT_PROJECT_ID)).toBe(false);
  });

  it("allows a system-scoped grant without a project identifier", () => {
    const auditor = identity(role("auditor").permissions, {});
    expect(hasPermission(auditor, "audit.read")).toBe(true);
    expect(hasPermission(auditor, "audit.export", DEFAULT_PROJECT_ID)).toBe(true);
    expect(hasPermission(auditor, "user.read")).toBe(false);
  });
});

function role(key: string) {
  const definition = builtInRoleDefinitions.find((candidate) => candidate.key === key);
  if (!definition) throw new Error(`Missing built-in role: ${key}`);
  return definition;
}

function identity(
  systemPermissions: Permission[],
  projectPermissions: Record<string, Permission[]>,
): AuthenticatedIdentity {
  return {
    user: userFixture,
    sessionId: "session-1",
    systemPermissions,
    projectPermissions,
  };
}

const userFixture: User = {
  id: "user-1",
  username: "tester",
  displayName: "Tester",
  source: "local",
  status: "active",
  forcePasswordChange: false,
  failedLoginAttempts: 0,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  version: 1,
};
