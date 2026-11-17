import { permissionCatalog } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import {
  permissionDescription,
  permissionLabel,
  isAssignablePermission,
} from "./permission-presentation";

describe("permission presentation", () => {
  it("gives every supported permission a human-friendly label and explanation", () => {
    for (const permission of permissionCatalog) {
      expect(permissionLabel(permission)).not.toBe(permission);
      expect(permissionLabel(permission)).not.toContain(".");
      expect(permissionDescription(permission).length).toBeGreaterThan(4);
    }
  });

  it("keeps unknown permissions identifiable for forward compatibility", () => {
    expect(permissionLabel("future.read")).toBe("future.read");
    expect(permissionDescription("future.read")).toContain("较新版本");
  });
});

it("keeps retired artifact permissions readable but unavailable for new selections", () => {
  expect(isAssignablePermission("artifact.read")).toBe(false);
  expect(isAssignablePermission("log.read")).toBe(true);
  expect(permissionLabel("artifact.read")).toContain("已退役");
});
