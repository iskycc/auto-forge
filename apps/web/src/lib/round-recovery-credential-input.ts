import type { RoundRecoveryCredentialReference } from "@autoforge/contracts";
import { assertSameJenkinsOrigin } from "@autoforge/domain";

export type RoundRecoveryCredentialChoice = RoundRecoveryCredentialReference & { label: string };
export type RecoveryCredentialDraft = {
  id: string;
  jenkinsJobUrl: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  apiKeySource?: RoundRecoveryCredentialChoice | undefined;
};

export function canReuseRecoveryCredential(
  candidate: RecoveryCredentialDraft,
  rules: readonly RecoveryCredentialDraft[],
  suiteId: string,
  targetRuleId: string,
): boolean {
  const visited = new Set([targetRuleId]);
  let current: RecoveryCredentialDraft | undefined = candidate;
  while (current) {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    if (!current.apiKeySource) return Boolean(current.apiKey || current.apiKeyConfigured);
    if (current.apiKeySource.suiteId !== suiteId) return true;
    const sourceRuleId: string = current.apiKeySource.ruleId;
    current = rules.find((rule) => rule.id === sourceRuleId);
  }
  return false;
}

export function recoveryInspectionCredential(
  rule: RecoveryCredentialDraft,
  rules: readonly RecoveryCredentialDraft[],
  suiteId: string,
): { apiKey?: string; apiKeySource?: RoundRecoveryCredentialReference } {
  const visited = new Set<string>();
  let current = rule;
  while (current.apiKeySource) {
    if (visited.has(current.id)) throw new Error("密钥复用存在循环引用，请重新选择。");
    visited.add(current.id);
    const reference = current.apiKeySource;
    if (reference.suiteId !== suiteId)
      return { apiKeySource: { suiteId: reference.suiteId, ruleId: reference.ruleId } };
    const source = rules.find((candidate) => candidate.id === reference.ruleId);
    if (!source) throw new Error("来源恢复步骤已删除，请重新选择密钥。");
    assertSameJenkinsOrigin(source.jenkinsJobUrl, current.jenkinsJobUrl);
    current = source;
  }
  if (current.apiKey) return { apiKey: current.apiKey };
  if (current === rule) return {};
  if (!current.apiKeyConfigured) throw new Error("来源恢复步骤尚未配置密钥。");
  return { apiKeySource: { suiteId, ruleId: current.id } };
}
