import type { RoundRecoveryCredentialReference, UpdateCaseSuiteInput } from "@autoforge/contracts";
import {
  DomainError,
  assertJenkinsCredential,
  assertSameJenkinsOrigin,
  type CaseSuite,
} from "@autoforge/domain";
import type { CaseSuiteRepository, SecretCipherPort } from "./ports";

type RecoveryRuleInput = NonNullable<
  NonNullable<UpdateCaseSuiteInput["policy"]>["roundRecoveryRules"]
>[number];

export function roundRecoverySecretPurpose(suiteId: string, ruleId: string): string {
  return `case-suite-round-recovery:${suiteId}:${ruleId}`;
}

export class RoundRecoveryCredentialResolver {
  constructor(
    private readonly suites: CaseSuiteRepository,
    private readonly cipher?: SecretCipherPort,
  ) {}

  async readSource(
    source: RoundRecoveryCredentialReference,
    targetJobUrl: string,
    projectIds?: readonly string[],
    currentSuite?: CaseSuite,
  ): Promise<string> {
    const suite =
      source.suiteId === currentSuite?.id
        ? currentSuite
        : await this.suites.getSummary(source.suiteId, projectIds);
    if (!suite)
      throw new DomainError("CASE_SUITE_NOT_FOUND", "复用密钥的来源任务不存在或无管理权限。");
    const rule = suite.policy.roundRecoveryRules.find(
      (candidate) => candidate.id === source.ruleId,
    );
    if (!rule?.apiKeyConfigured)
      throw new DomainError(
        "JENKINS_CREDENTIAL_REQUIRED",
        "来源恢复步骤已删除或尚未配置密钥，请重新选择。",
      );
    assertSameJenkinsOrigin(rule.jenkinsJobUrl, targetJobUrl);
    const cipher = this.requireCipher();
    const ciphertext = (await this.suites.getRoundRecoveryCredentials(suite.id, [rule.id]))[
      rule.id
    ];
    if (!ciphertext)
      throw new DomainError(
        "JENKINS_CREDENTIAL_REQUIRED",
        "来源恢复步骤的 Jenkins API 密钥缺失，请重新选择。",
      );
    const credential = cipher.decrypt(ciphertext, roundRecoverySecretPurpose(suite.id, rule.id));
    assertJenkinsCredential(credential);
    return credential;
  }

  async prepare(
    suite: CaseSuite,
    rules: readonly RecoveryRuleInput[],
    projectIds?: readonly string[],
  ): Promise<Record<string, string>> {
    const existing = await this.suites.getRoundRecoveryCredentials(
      suite.id,
      rules.map((rule) => rule.id),
    );
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    const resolved = new Map<string, string>();
    const resolve = async (
      rule: RecoveryRuleInput,
      visiting: ReadonlySet<string>,
    ): Promise<string> => {
      if (visiting.has(rule.id))
        throw new DomainError(
          "JENKINS_CREDENTIAL_REFERENCE_CYCLE",
          "密钥复用存在循环引用，请选择输入新密钥或已保存的独立密钥。",
        );
      const cached = resolved.get(rule.id);
      if (cached !== undefined) return cached;
      let credential: string;
      if (rule.apiKey !== undefined) {
        assertJenkinsCredential(rule.apiKey);
        credential = rule.apiKey;
      } else if (rule.apiKeySource) {
        const draft =
          rule.apiKeySource.suiteId === suite.id ? byId.get(rule.apiKeySource.ruleId) : undefined;
        if (rule.apiKeySource.suiteId === suite.id && !draft) {
          throw new DomainError(
            "JENKINS_CREDENTIAL_REQUIRED",
            "本任务的来源恢复步骤已删除，请重新选择密钥。",
          );
        }
        if (draft) {
          assertSameJenkinsOrigin(draft.jenkinsJobUrl, rule.jenkinsJobUrl);
          credential = await resolve(draft, new Set([...visiting, rule.id]));
        } else {
          credential = await this.readSource(
            rule.apiKeySource,
            rule.jenkinsJobUrl,
            projectIds,
            suite,
          );
        }
      } else {
        credential = await this.readSource(
          { suiteId: suite.id, ruleId: rule.id },
          rule.jenkinsJobUrl,
          projectIds,
          suite,
        );
      }
      resolved.set(rule.id, credential);
      return credential;
    };
    const upserts: Record<string, string> = {};
    for (const rule of rules) {
      if (rule.apiKey !== undefined || rule.apiKeySource) {
        const credential = await resolve(rule, new Set());
        upserts[rule.id] = this.requireCipher().encrypt(
          credential,
          roundRecoverySecretPurpose(suite.id, rule.id),
        );
      } else if (!existing[rule.id]) {
        throw new DomainError(
          "JENKINS_CREDENTIAL_REQUIRED",
          `第 ${rule.afterRound} 轮后的 Jenkins 环境恢复尚未配置 API 密钥。`,
        );
      }
    }
    return upserts;
  }

  private requireCipher(): SecretCipherPort {
    if (!this.cipher?.available)
      throw new DomainError(
        "SECRET_CIPHER_UNAVAILABLE",
        "配置或复用 Jenkins 环境恢复密钥需要当前 AutoForge 主密钥。",
      );
    return this.cipher;
  }
}
