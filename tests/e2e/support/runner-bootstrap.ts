import { issueRunnerBootstrapToken } from "../../../apps/web/src/lib/runner-bootstrap-token";

export function freshRunnerBootstrapToken(): string {
  const masterKey = process.env.E2E_RUNNER_BOOTSTRAP_MASTER_KEY?.trim();
  if (masterKey) return issueRunnerBootstrapToken(masterKey, new Date());

  const configuredToken = process.env.E2E_RUNNER_BOOTSTRAP_TOKEN?.trim();
  if (!configuredToken) {
    throw new Error(
      "E2E_RUNNER_BOOTSTRAP_MASTER_KEY or E2E_RUNNER_BOOTSTRAP_TOKEN is required for runner acceptance.",
    );
  }
  return configuredToken;
}
