import type {
  RunnerHostConnection,
  RunnerInstallationMode,
  RunnerAgentInstallationResult,
} from "@autoforge/contracts";
import { DomainError, type Runner } from "@autoforge/domain";

import { RunnerAgentInstaller } from "./runner-agent-installer";

export type RunnerAgentUpdateTarget = {
  connection: RunnerHostConnection;
  expectedHostKeySha256: string;
  installationMode: RunnerInstallationMode;
  runAsRoot: boolean;
  dataDirectory?: string;
  caCertificatePem?: string;
};

/** 原地更新共享实现：UI 单机更新和批量更新必须走同一配置保留规则。 */
export async function updateRunnerAgent(
  installer: RunnerAgentInstaller,
  runner: Runner,
  target: RunnerAgentUpdateTarget,
): Promise<RunnerAgentInstallationResult & { dataDirectory: string }> {
  if (runner.deregisteredAt || runner.purgedAt) {
    throw new DomainError("RUNNER_UPDATE_NOT_ALLOWED", "执行机已注销，不能原地更新。", {
      details: { runnerId: runner.id },
    });
  }
  const dataDirectory =
    target.dataDirectory ??
    (await installer.readRemoteDataDirectory(target.connection, target.expectedHostKeySha256));
  const result = await installer.install({
    ...target,
    dataDirectory,
    name: runner.name,
    labels: runner.labels,
    maxConcurrency: runner.maxConcurrency,
    terminalEnabled: runner.terminalEnabled,
  });
  return { ...result, dataDirectory };
}
