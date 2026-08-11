import {
  builtInRoleDefinitions,
  countSystemAdministrators,
  DEFAULT_PROJECT_ID,
  hasPermission,
  permissionCatalog,
  projectIdsForPermission,
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

  it("derives a stable project filter without broadening system access", () => {
    const scoped = identity([], {
      "project-b": role("viewer").permissions,
      "project-a": role("execution-operator").permissions,
      "project-c": ["audit.read"],
    });
    expect(projectIdsForPermission(scoped, "run.read")).toEqual(["project-a", "project-b"]);
    expect(projectIdsForPermission(scoped, "artifact.read")).toEqual(["project-a", "project-b"]);
    expect(projectIdsForPermission(scoped, "case.manage")).toEqual([]);
    expect(projectIdsForPermission(identity(["run.read"], {}), "run.read")).toBeUndefined();
  });

  it.each([
    ["system-admin", true, true, true, true],
    ["project-admin", true, true, true, true],
    ["test-manager", true, true, true, false],
    ["execution-operator", true, true, true, false],
    ["viewer", true, false, true, false],
    ["auditor", true, false, true, false],
  ] as const)(
    "%s enforces the page, API, artifact, and terminal WebSocket matrix",
    (roleKey, pageAllowed, createApiAllowed, artifactAllowed, terminalAllowed) => {
      const definition = role(roleKey);
      const scopedIdentity =
        definition.scope === "system"
          ? identity(definition.permissions, {})
          : identity([], { [DEFAULT_PROJECT_ID]: definition.permissions });
      expect(hasPermission(scopedIdentity, "run.read", DEFAULT_PROJECT_ID)).toBe(pageAllowed);
      expect(hasPermission(scopedIdentity, "run.create", DEFAULT_PROJECT_ID)).toBe(
        createApiAllowed,
      );
      expect(hasPermission(scopedIdentity, "artifact.read", DEFAULT_PROJECT_ID)).toBe(
        artifactAllowed,
      );
      expect(hasPermission(scopedIdentity, "runner.terminal", DEFAULT_PROJECT_ID)).toBe(
        terminalAllowed,
      );
    },
  );
});

describe("countSystemAdministrators", () => {
  const adminPermissions: Permission[] = ["user.manage", "role.manage"];
  const bindings = [
    { userId: "user-1", roleId: "role-a", permissions: adminPermissions },
    { userId: "user-1", roleId: "role-b", permissions: ["user.read"] as Permission[] },
    { userId: "user-2", roleId: "role-a", permissions: adminPermissions },
    { userId: "user-3", roleId: "role-c", permissions: ["user.manage"] as Permission[] },
  ];

  it("counts only users holding every recovery permission", () => {
    expect(countSystemAdministrators(bindings)).toBe(2);
  });

  it("evaluates role deactivation against the remaining administrators", () => {
    expect(countSystemAdministrators(bindings, { roleId: "role-a" })).toBe(0);
    expect(countSystemAdministrators(bindings, { roleId: "role-b" })).toBe(2);
  });

  it("evaluates removing a single binding without ignoring the user's other roles", () => {
    expect(countSystemAdministrators(bindings, { userId: "user-2", roleId: "role-a" })).toBe(1);
    expect(countSystemAdministrators(bindings, { userId: "user-1" })).toBe(1);
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
