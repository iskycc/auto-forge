import { DomainError } from "@autoforge/domain";
import type {
  RunnerControlService,
  RunnerInstallationProfileService,
} from "@autoforge/application";
import type { UninstallRunnerAgentRequest } from "@autoforge/contracts";
import type { RunnerAgentInstaller } from "./runner-agent-installer";

export async function uninstallRunnerAgent(
  dependencies: {
    runnerControl: Pick<RunnerControlService, "get" | "deregisterRunner">;
    runnerInstallationProfiles: Pick<
      RunnerInstallationProfileService,
      "connectionByProfileId" | "finalizeUninstall"
    >;
    runnerAgentInstaller: Pick<RunnerAgentInstaller, "uninstall">;
  },
  runnerId: string,
  input: UninstallRunnerAgentRequest,
) {
  const runner = await dependencies.runnerControl.get(runnerId);
  const target = await resolveUninstallTarget(
    dependencies.runnerInstallationProfiles,
    runnerId,
    input,
  );
  const result = await dependencies.runnerAgentInstaller.uninstall(target, runnerId, async () => {
    if (!runner.deregisteredAt) await dependencies.runnerControl.deregisterRunner(runnerId);
  });
  // Keep the saved connection until host cleanup succeeds, so partial failures
  // remain visible as deregistered nodes and can be retried with the same SSH key.
  await dependencies.runnerInstallationProfiles.finalizeUninstall(runnerId);
  return result;
}

async function resolveUninstallTarget(
  profiles: Pick<RunnerInstallationProfileService, "connectionByProfileId">,
  runnerId: string,
  input: UninstallRunnerAgentRequest,
) {
  if (!("profileId" in input)) return input;
  const stored = await profiles.connectionByProfileId(input.profileId);
  if (stored.profile.runnerId !== runnerId) {
    throw new DomainError(
      "RUNNER_INSTALLATION_PROFILE_MISMATCH",
      "保存的连接信息不属于当前执行机，请重新填写并核验主机。",
    );
  }
  return {
    connection: stored.connection,
    expectedHostKeySha256: stored.profile.expectedHostKeySha256,
    installationMode: stored.profile.installationMode,
  };
}
