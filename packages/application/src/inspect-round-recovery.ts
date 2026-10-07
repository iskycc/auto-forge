import type {
  InspectRoundRecoveryConfigurationInput,
  JenkinsJobInspection,
} from "@autoforge/contracts";
import { DomainError, assertJenkinsCredential, type CaseSuite } from "@autoforge/domain";

import type { CaseSuiteRepository, JenkinsRoundRecoveryTransport, SecretCipherPort } from "./ports";
import {
  roundRecoverySecretPurpose,
  RoundRecoveryCredentialResolver,
} from "./round-recovery-credentials";

export class RoundRecoveryConfigurationInspector {
  constructor(
    private readonly suites: CaseSuiteRepository,
    private readonly transport: JenkinsRoundRecoveryTransport,
    private readonly secretCipher?: SecretCipherPort,
  ) {}

  async inspect(
    suite: CaseSuite,
    input: InspectRoundRecoveryConfigurationInput,
    projectIds?: readonly string[],
  ): Promise<JenkinsJobInspection> {
    const credential =
      input.apiKey ??
      (input.apiKeySource
        ? await new RoundRecoveryCredentialResolver(this.suites, this.secretCipher).readSource(
            input.apiKeySource,
            input.jenkinsJobUrl,
            projectIds,
            suite,
          )
        : await this.storedCredential(suite, input.ruleId, input.jenkinsJobUrl));
    assertJenkinsCredential(credential);
    try {
      return await this.transport.inspectJob({ jobUrl: input.jenkinsJobUrl, credential });
    } catch (error) {
      throw new DomainError(
        "JENKINS_CONFIGURATION_TEST_FAILED",
        error instanceof Error ? error.message : "无法读取 Jenkins 任务信息。",
        { cause: error },
      );
    }
  }

  private async storedCredential(
    suite: CaseSuite,
    ruleId: string,
    requestedJobUrl: string,
  ): Promise<string> {
    const rule = suite.policy.roundRecoveryRules.find((candidate) => candidate.id === ruleId);
    if (!rule?.apiKeyConfigured) {
      throw new DomainError(
        "JENKINS_CREDENTIAL_REQUIRED",
        "请填写 Jenkins API 密钥，或先保存已配置密钥的恢复步骤。",
      );
    }
    if (normalizedJobUrl(rule.jenkinsJobUrl) !== normalizedJobUrl(requestedJobUrl)) {
      throw new DomainError(
        "JENKINS_CREDENTIAL_REQUIRED",
        "Jenkins 任务链接已修改，请重新填写 API 密钥后再测试。",
      );
    }
    if (!this.secretCipher?.available) {
      throw new DomainError(
        "SECRET_CIPHER_UNAVAILABLE",
        "读取已保存的 Jenkins API 密钥需要当前 AutoForge 主密钥。",
      );
    }
    const ciphertext = (await this.suites.getRoundRecoveryCredentials(suite.id, [ruleId]))[ruleId];
    if (!ciphertext) {
      throw new DomainError("JENKINS_CREDENTIAL_REQUIRED", "已保存的 Jenkins API 密钥缺失。");
    }
    return this.secretCipher.decrypt(ciphertext, roundRecoverySecretPurpose(suite.id, ruleId));
  }
}

function normalizedJobUrl(value: string): string {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}
