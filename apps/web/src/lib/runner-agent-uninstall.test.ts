import { describe, expect, it, vi } from "vitest";
import type { Runner } from "@autoforge/domain";
import { uninstallRunnerAgent } from "./runner-agent-uninstall";

function fixture() {
  const calls: string[] = [];
  const connection = { host: "10.0.0.2", port: 22, username: "root", password: "private" };
  const profile = {
    id: "profile-one",
    runnerId: "runner-one",
    runnerName: "runner",
    connectionEncrypted: "encrypted",
    expectedHostKeySha256: `SHA256:${"A".repeat(43)}`,
    installationMode: "auto" as const,
    runAsRoot: false,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  };
  const result = {
    uninstalled: true as const,
    dataDirectory: "/var/lib/autoforge-agent",
    dataDirectoryRetained: false,
  };
  return {
    calls,
    profile,
    result,
    dependencies: {
      runnerControl: {
        get: vi.fn(async () => ({ id: "runner-one" }) as Runner),
        deregisterRunner: vi.fn(async () => {
          calls.push("deregister");
          return {} as Runner;
        }),
      },
      runnerInstallationProfiles: {
        connectionByProfileId: vi.fn(async () => ({ profile, connection })),
        finalizeUninstall: vi.fn(async () => {
          calls.push("complete-platform-cleanup");
        }),
      },
      runnerAgentInstaller: {
        uninstall: vi.fn(
          async (_input: unknown, _id: string, beforeRemoval: () => Promise<void>) => {
            calls.push("verify-host-identity");
            await beforeRemoval();
            calls.push("remote-cleanup");
            return result;
          },
        ),
      },
    },
  };
}

describe("Agent uninstall orchestration", () => {
  it("verifies host identity before revocation and keeps cleanup before platform removal", async () => {
    const { dependencies, calls, result } = fixture();
    await expect(
      uninstallRunnerAgent(dependencies, "runner-one", { profileId: "profile-one", confirm: true }),
    ).resolves.toEqual(result);
    expect(calls).toEqual([
      "verify-host-identity",
      "deregister",
      "remote-cleanup",
      "complete-platform-cleanup",
    ]);
  });
  it("rejects a different node's profile before contacting its host", async () => {
    const { dependencies, profile } = fixture();
    profile.runnerId = "other-runner";
    await expect(
      uninstallRunnerAgent(dependencies, "runner-one", { profileId: "profile-one", confirm: true }),
    ).rejects.toMatchObject({ code: "RUNNER_INSTALLATION_PROFILE_MISMATCH" });
    expect(dependencies.runnerAgentInstaller.uninstall).not.toHaveBeenCalled();
    expect(dependencies.runnerControl.deregisterRunner).not.toHaveBeenCalled();
  });
  it("keeps node and stored connection visible after remote cleanup fails", async () => {
    const { dependencies } = fixture();
    dependencies.runnerAgentInstaller.uninstall.mockImplementationOnce(
      async (_input, _id, beforeRemoval) => {
        await beforeRemoval();
        throw new Error("disk cleanup failed");
      },
    );
    await expect(
      uninstallRunnerAgent(dependencies, "runner-one", { profileId: "profile-one", confirm: true }),
    ).rejects.toThrow("disk cleanup failed");
    expect(dependencies.runnerControl.deregisterRunner).toHaveBeenCalledOnce();
    expect(dependencies.runnerInstallationProfiles.finalizeUninstall).not.toHaveBeenCalled();
  });
  it("leaves a node unchanged when SSH or identity preflight fails", async () => {
    const { dependencies } = fixture();
    dependencies.runnerAgentInstaller.uninstall.mockRejectedValueOnce(
      new Error("identity mismatch"),
    );
    await expect(
      uninstallRunnerAgent(dependencies, "runner-one", { profileId: "profile-one", confirm: true }),
    ).rejects.toThrow("identity mismatch");
    expect(dependencies.runnerControl.deregisterRunner).not.toHaveBeenCalled();
  });
});
