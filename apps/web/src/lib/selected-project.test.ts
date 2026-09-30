import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedIdentity, Project } from "@autoforge/domain";
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "read-only-project" }) }),
}));
import { selectedProjectId } from "./selected-project";

describe("selected project authorization boundary", () => {
  it("keeps the selected project instead of silently substituting an executable project", async () => {
    const identity = {
      systemPermissions: [],
      projectPermissions: {
        "read-only-project": ["case.read"],
        "executable-project": ["run.create"],
      },
    } as unknown as AuthenticatedIdentity;
    const projects = [{ id: "read-only-project" }, { id: "executable-project" }] as Project[];
    expect(await selectedProjectId(identity, projects, "run.create")).toBe("read-only-project");
  });
});
