import { describe, expect, it } from "vitest";
import { renameProjectInputSchema, uninstallRunnerAgentRequestSchema } from "../src";

describe("project rename and Agent uninstall inputs", () => {
  it("trims project names and rejects blank names, long names and identity changes", () => {
    expect(renameProjectInputSchema.parse({ name: "  默认项目新名称  " })).toEqual({
      name: "默认项目新名称",
    });
    for (const input of [
      { name: " " },
      { name: "x".repeat(121) },
      { name: "Changed", slug: "changed" },
      { name: "Changed", isDefault: false },
    ])
      expect(renameProjectInputSchema.safeParse(input).success).toBe(false);
  });
  it("requires explicit destructive consent and a stored connection or verified manual connection", () => {
    expect(
      uninstallRunnerAgentRequestSchema.safeParse({ profileId: "profile", confirm: true }).success,
    ).toBe(true);
    for (const input of [
      { profileId: "profile" },
      { profileId: "profile", confirm: false },
      { confirm: true },
    ])
      expect(uninstallRunnerAgentRequestSchema.safeParse(input).success).toBe(false);
    expect(
      uninstallRunnerAgentRequestSchema.safeParse({
        connection: { host: "10.0.0.2", port: 22, username: "root", password: "private" },
        expectedHostKeySha256: `SHA256:${"A".repeat(43)}`,
        confirm: true,
      }).success,
    ).toBe(true);
  });
});
