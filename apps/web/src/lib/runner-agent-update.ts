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

export type RunnerAgentUpgradeTarget = Pick<
  RunnerAgentUpdateTarget,
  "connection" | "expectedHostKeySha256" | "installationMode"
>;

/** 单机更新会应用对话框中明确提交的部署配置；批量升级不得调用此实现。 */
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

/** 批量升级不携带配置变更，只替换 Agent 与 Adapter 程序资源。 */
export async function upgradeRunnerAgent(
  installer: RunnerAgentInstaller,
  runner: Runner,
  target: RunnerAgentUpgradeTarget,
): Promise<RunnerAgentInstallationResult> {
  if (runner.deregisteredAt || runner.purgedAt) {
    throw new DomainError("RUNNER_UPDATE_NOT_ALLOWED", "执行机已注销，不能原地更新。", {
      details: { runnerId: runner.id },
    });
  }
  return installer.upgrade({
    connection: target.connection,
    expectedHostKeySha256: target.expectedHostKeySha256,
    installationMode: target.installationMode,
  });
}
