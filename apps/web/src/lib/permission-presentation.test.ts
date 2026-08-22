import { permissionCatalog } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { permissionDescription, permissionLabel } from "./permission-presentation";

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
