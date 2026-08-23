import type {
  CopyCaseSuiteInput,
  CreateCaseSuiteInput,
  UpdateCaseSuiteInput,
} from "@autoforge/contracts";
import {
  DEFAULT_PROJECT_ID,
  DomainError,
  defaultCaseSuiteExecutionPolicy,
  mergeCaseSuiteExecutionPolicy,
  type CaseSuiteExecutionPolicy,
  type RetryConcurrencyRule,
  type RoundRecoveryRule,
} from "@autoforge/domain";

import type {
  CaseCatalogRepository,
  CaseSuiteRepository,
  Clock,
  IdGenerator,
  ProjectStructureRepository,
  SecretCipherPort,
} from "./ports";
import { roundRecoverySecretPurpose } from "./round-recovery-credentials";

export class CaseSuiteService {
  constructor(
    private readonly suites: CaseSuiteRepository,
    private readonly catalog: CaseCatalogRepository,
    private readonly projectStructures: ProjectStructureRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly secretCipher?: SecretCipherPort,
  ) {}

  async create(input: CreateCaseSuiteInput, actorId?: string) {
    const description = input.description?.trim();
    const projectId = input.projectId ?? DEFAULT_PROJECT_ID;
    const projectVersionId = await this.resolveActiveProjectVersion(
      projectId,
      input.projectVersionId,
    );
    return this.suites.create({
      id: this.ids.next(),
      projectId,
      ...(actorId ? { actorId } : {}),
      name: input.name.trim(),
      ...(description ? { description } : {}),
      policy: mergeCaseSuiteExecutionPolicy(defaultCaseSuiteExecutionPolicy, {
        ...(input.adapter ? { adapter: input.adapter } : {}),
        projectVersionId,
      }),
      createdAt: this.clock.now().toISOString(),
    });
  }

  list(limit = 200, projectIds?: readonly string[], projectVersionId?: string) {
    return this.suites.list(limit, projectIds, projectVersionId);
  }

  async get(suiteId: string, projectIds?: readonly string[]) {
    const suite = await this.suites.get(suiteId, projectIds);
    if (!suite) throw new DomainError("CASE_SUITE_NOT_FOUND", "指定的用例任务不存在。");
    return suite;
  }

  private async getSummary(suiteId: string, projectIds?: readonly string[]) {
    const suite = await this.suites.getSummary(suiteId, projectIds);
    if (!suite) throw new DomainError("CASE_SUITE_NOT_FOUND", "指定的用例任务不存在。");
    return suite;
  }

  async update(
    suiteId: string,
    input: UpdateCaseSuiteInput,
    actorId?: string,
    projectIds?: readonly string[],
  ) {
    const suite = await this.getSummary(suiteId, projectIds);
    if (input.expectedRevision !== suite.revision) {
      throw new DomainError("CASE_SUITE_REVISION_CONFLICT", "用例任务已被他人修改，请刷新后重试。");
    }
    const name = input.name?.trim();
    const policyUpdate = input.policy
      ? await this.preparePolicyUpdate(suite.id, suite.policy, input.policy)
      : undefined;
    const policy = policyUpdate?.policy;
    if (policy) assertRunnableResourceSelection(policy);
    if (policy?.projectVersionId && policy.projectVersionId !== suite.policy.projectVersionId) {
      await this.resolveActiveProjectVersion(suite.projectId, policy.projectVersionId);
      const details = await this.get(suiteId, projectIds);
      if (
        details.items.some(
          (item) => item.caseDefinition.projectVersionId !== policy.projectVersionId,
        )
      ) {
        throw new DomainError(
          "CASE_SUITE_VERSION_MISMATCH",
          "任务中的用例不属于目标项目版本，请先清空或重新选择用例。",
        );
      }
    }
    const changeReason = describeSuiteChange(input);
    return this.suites.updateSuite({
      suiteId,
      expectedRevision: input.expectedRevision,
      versionId: this.ids.next(),
      changeReason,
      ...(actorId ? { actorId } : {}),
      updatedAt: this.clock.now().toISOString(),
      ...(name !== undefined ? { name } : {}),
      ...(input.description !== undefined
        ? { description: input.description.trim() ? input.description.trim() : null }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      ...(policy ? { policy } : {}),
      ...(policyUpdate && Object.keys(policyUpdate.credentialUpserts).length > 0
        ? { roundRecoveryCredentialUpserts: policyUpdate.credentialUpserts }
        : {}),
    });
  }

  async copy(
    suiteId: string,
    input: CopyCaseSuiteInput,
    actorId?: string,
    projectIds?: readonly string[],
  ) {
    const source = await this.get(suiteId, projectIds);
    const projectVersionId = source.policy.projectVersionId;
    if (!projectVersionId) {
      throw new DomainError(
        "CASE_SUITE_VERSION_REQUIRED",
        "历史任务尚未关联项目版本，请先在任务设置中选择版本。",
      );
    }
    await this.resolveActiveProjectVersion(source.projectId, projectVersionId);
    const createdAt = this.clock.now().toISOString();
    const copiedSuiteId = this.ids.next();
    const sourceCredentials =
      source.policy.roundRecoveryRules.length === 0
        ? {}
        : await this.suites.getRoundRecoveryCredentials(
            source.id,
            source.policy.roundRecoveryRules.map((rule) => rule.id),
          );
    const copiedRecovery = this.copyRoundRecoveryRules(
      source.id,
      copiedSuiteId,
      source.policy.roundRecoveryRules,
      sourceCredentials,
    );
    return this.suites.copySuite({
      id: copiedSuiteId,
      projectId: source.projectId,
      name: input.name.trim(),
      ...(source.description ? { description: source.description } : {}),
      policy: mergeCaseSuiteExecutionPolicy(source.policy, {
        roundRecoveryRules: copiedRecovery.rules,
      }),
      items: source.items.map((item) => ({
        id: this.ids.next(),
        caseDefinitionId: item.caseDefinition.id,
      })),
      versionId: this.ids.next(),
      ...(actorId ? { actorId } : {}),
      createdAt,
      ...(Object.keys(copiedRecovery.credentials).length > 0
        ? { roundRecoveryCredentials: copiedRecovery.credentials }
        : {}),
    });
  }

  private async preparePolicyUpdate(
    suiteId: string,
    current: CaseSuiteExecutionPolicy,
    input: NonNullable<UpdateCaseSuiteInput["policy"]>,
  ): Promise<{ policy: CaseSuiteExecutionPolicy; credentialUpserts: Record<string, string> }> {
    const { retryConcurrencyRules, roundRecoveryRules, ...baseInput } = input;
    const normalizedRetryRules = retryConcurrencyRules?.map(normalizeRetryConcurrencyRule);
    const existingCredentials = roundRecoveryRules
      ? await this.suites.getRoundRecoveryCredentials(
          suiteId,
          roundRecoveryRules.map((rule) => rule.id),
        )
      : {};
    const normalizedRecovery = roundRecoveryRules
      ? this.prepareRoundRecoveryRules(suiteId, roundRecoveryRules, existingCredentials)
      : undefined;
    const policy = mergeCaseSuiteExecutionPolicy(current, {
      ...baseInput,
      ...(normalizedRetryRules ? { retryConcurrencyRules: normalizedRetryRules } : {}),
      ...(normalizedRecovery ? { roundRecoveryRules: normalizedRecovery.rules } : {}),
    });
    assertRetryOrchestrationPolicy(policy);
    return { policy, credentialUpserts: normalizedRecovery?.credentialUpserts ?? {} };
  }

  private prepareRoundRecoveryRules(
    suiteId: string,
    input: NonNullable<NonNullable<UpdateCaseSuiteInput["policy"]>["roundRecoveryRules"]>,
    existingCredentials: Record<string, string>,
  ): { rules: RoundRecoveryRule[]; credentialUpserts: Record<string, string> } {
    const credentialUpserts: Record<string, string> = {};
    const rules = input.map((rule): RoundRecoveryRule => {
      const suppliedApiKey = rule.apiKey;
      const credentialSeparator = suppliedApiKey?.indexOf(":") ?? -1;
      if (
        suppliedApiKey !== undefined &&
        (credentialSeparator <= 0 || credentialSeparator === suppliedApiKey.length - 1)
      ) {
        throw new DomainError(
          "JENKINS_CREDENTIAL_INVALID",
          "Jenkins API 密钥需填写为“用户名:API Token”。",
        );
      }
      if (suppliedApiKey !== undefined) {
        if (!this.secretCipher?.available) {
          throw new DomainError(
            "SECRET_CIPHER_UNAVAILABLE",
            "配置 Jenkins 环境恢复前必须先设置 AutoForge 主密钥。",
          );
        }
        credentialUpserts[rule.id] = this.secretCipher.encrypt(
          suppliedApiKey,
          roundRecoverySecretPurpose(suiteId, rule.id),
        );
      }
      if (!credentialUpserts[rule.id] && !existingCredentials[rule.id]) {
        throw new DomainError(
          "JENKINS_CREDENTIAL_REQUIRED",
          `第 ${rule.afterRound} 轮后的 Jenkins 环境恢复尚未配置 API 密钥。`,
        );
      }
      return {
        id: rule.id,
        afterRound: rule.afterRound,
        jenkinsJobUrl: normalizeJenkinsJobUrl(rule.jenkinsJobUrl),
        waitMinutes: rule.waitMinutes,
        apiKeyConfigured: true,
      };
    });
    return { rules, credentialUpserts };
  }

  private copyRoundRecoveryRules(
    sourceSuiteId: string,
    targetSuiteId: string,
    sourceRules: readonly RoundRecoveryRule[],
    sourceCredentials: Record<string, string>,
  ): { rules: RoundRecoveryRule[]; credentials: Record<string, string> } {
    if (sourceRules.length === 0) return { rules: [], credentials: {} };
    if (!this.secretCipher?.available) {
      throw new DomainError(
        "SECRET_CIPHER_UNAVAILABLE",
        "复制含 Jenkins 环境恢复配置的任务需要当前 AutoForge 主密钥。",
      );
    }
    const cipher = this.secretCipher;
    const credentials: Record<string, string> = {};
    const rules = sourceRules.map((sourceRule) => {
      const ciphertext = sourceCredentials[sourceRule.id];
      if (!ciphertext) {
        throw new DomainError("JENKINS_CREDENTIAL_REQUIRED", "源任务的 Jenkins API 密钥缺失。");
      }
      const id = this.ids.next();
      const plaintext = cipher.decrypt(
        ciphertext,
        roundRecoverySecretPurpose(sourceSuiteId, sourceRule.id),
      );
      credentials[id] = cipher.encrypt(plaintext, roundRecoverySecretPurpose(targetSuiteId, id));
      return { ...sourceRule, id };
    });
    return { rules, credentials };
  }

  async addCases(
    suiteId: string,
    requestedIds: string[],
    actorId?: string,
    projectIds?: readonly string[],
  ) {
    const suite = await this.getSummary(suiteId, projectIds);
    const projectVersionId = suite.policy.projectVersionId;
    if (!projectVersionId) {
      throw new DomainError(
        "CASE_SUITE_VERSION_REQUIRED",
        "历史任务尚未关联项目版本，请先在任务设置中选择版本。",
      );
    }
    const uniqueIds = [...new Set(requestedIds)];
    const existingIds = await this.catalog.findExistingCaseIds(
      uniqueIds,
      suite.projectId,
      projectVersionId,
    );
    if (existingIds.length !== uniqueIds.length) {
      throw new DomainError(
        "CASE_DEFINITION_VERSION_MISMATCH",
        "选择中包含不存在或不属于任务版本的用例。",
      );
    }
    return this.suites.addCases({
      suiteId,
      items: existingIds.map((caseDefinitionId) => ({
        id: this.ids.next(),
        caseDefinitionId,
      })),
      versionId: this.ids.next(),
      ...(actorId ? { actorId } : {}),
      updatedAt: this.clock.now().toISOString(),
    });
  }

  async missingCaseIds(
    suiteId: string,
    requestedIds: string[],
    projectIds?: readonly string[],
  ): Promise<string[]> {
    const suite = await this.getSummary(suiteId, projectIds);
    const projectVersionId = suite.policy.projectVersionId;
    if (!projectVersionId) {
      throw new DomainError(
        "CASE_SUITE_VERSION_REQUIRED",
        "历史任务尚未关联项目版本，请先在任务设置中选择版本。",
      );
    }
    const uniqueIds = [...new Set(requestedIds)];
    const existingIds = await this.catalog.findExistingCaseIds(
      uniqueIds,
      suite.projectId,
      projectVersionId,
    );
    if (existingIds.length !== uniqueIds.length) {
      throw new DomainError(
        "CASE_DEFINITION_VERSION_MISMATCH",
        "筛选范围包含不存在或不属于任务版本的用例。",
      );
    }
    const memberIds = new Set(await this.suites.findMemberCaseDefinitionIds(suiteId, existingIds));
    return uniqueIds.filter((caseDefinitionId) => !memberIds.has(caseDefinitionId));
  }

  async removeCase(
    suiteId: string,
    caseDefinitionId: string,
    actorId?: string,
    projectIds?: readonly string[],
  ) {
    return this.removeCases(suiteId, [caseDefinitionId], actorId, projectIds);
  }

  async removeCases(
    suiteId: string,
    caseDefinitionIds: string[],
    actorId?: string,
    projectIds?: readonly string[],
  ) {
    await this.getSummary(suiteId, projectIds);
    const uniqueIds = [...new Set(caseDefinitionIds)];
    if (uniqueIds.length === 0) {
      throw new DomainError("CASE_SUITE_SELECTION_INVALID", "请至少选择一个待移除用例。");
    }
    return this.suites.removeCases({
      suiteId,
      caseDefinitionIds: uniqueIds,
      versionId: this.ids.next(),
      ...(actorId ? { actorId } : {}),
      updatedAt: this.clock.now().toISOString(),
    });
  }

  private async resolveActiveProjectVersion(
    projectId: string,
    requestedProjectVersionId?: string,
  ): Promise<string> {
    const structure = await this.projectStructures.list(projectId);
    if (requestedProjectVersionId) {
      const version = structure.versions.find((entry) => entry.id === requestedProjectVersionId);
      if (!version || version.projectId !== projectId) {
        throw new DomainError(
          "PROJECT_VERSION_NOT_FOUND",
          "指定的项目版本不存在或不属于当前项目。",
        );
      }
      if (version.status !== "active") {
        throw new DomainError("PROJECT_VERSION_ARCHIVED", "已归档的项目版本不能关联新任务。");
      }
      return version.id;
    }
    const activeVersions = structure.versions.filter((version) => version.status === "active");
    if (activeVersions.length !== 1) {
      throw new DomainError("CASE_SUITE_VERSION_REQUIRED", "请先选择任务所属的项目版本。");
    }
    return activeVersions[0]!.id;
  }
}

function normalizeRetryConcurrencyRule(
  rule: NonNullable<NonNullable<UpdateCaseSuiteInput["policy"]>["retryConcurrencyRules"]>[number],
): RetryConcurrencyRule {
  return {
    id: rule.id,
    executionRoundFrom: rule.executionRoundFrom,
    executionRoundTo: rule.executionRoundTo,
    ...(rule.previousRoundPassRateMinimum !== undefined
      ? { previousRoundPassRateMinimum: rule.previousRoundPassRateMinimum }
      : {}),
    ...(rule.previousRoundPassRateMaximum !== undefined
      ? { previousRoundPassRateMaximum: rule.previousRoundPassRateMaximum }
      : {}),
    ...(rule.remainingRunsMinimum !== undefined
      ? { remainingRunsMinimum: rule.remainingRunsMinimum }
      : {}),
    ...(rule.remainingRunsMaximum !== undefined
      ? { remainingRunsMaximum: rule.remainingRunsMaximum }
      : {}),
    concurrency: rule.concurrency,
  };
}

function assertRetryOrchestrationPolicy(policy: CaseSuiteExecutionPolicy): void {
  if (
    policy.retryMode !== "round" &&
    (policy.retryConcurrencyRules.length > 0 || policy.roundRecoveryRules.length > 0)
  ) {
    throw new DomainError(
      "ROUND_RETRY_REQUIRED",
      "动态重跑并发和 Jenkins 环境恢复只适用于整轮重跑模式。",
    );
  }
  const maximumExecutionRound = policy.retryLimit + 1;
  if (
    policy.retryConcurrencyRules.some(
      (rule) =>
        rule.executionRoundFrom > maximumExecutionRound ||
        rule.executionRoundTo > maximumExecutionRound,
    )
  ) {
    throw new DomainError("RETRY_RULE_ROUND_INVALID", "动态并发规则的轮次超过了任务最大重跑轮次。");
  }
  if (policy.roundRecoveryRules.some((rule) => rule.afterRound > policy.retryLimit)) {
    throw new DomainError("RECOVERY_RULE_ROUND_INVALID", "环境恢复边界之后必须存在下一轮重跑。");
  }
}

function normalizeJenkinsJobUrl(value: string): string {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function assertRunnableResourceSelection(policy: {
  runnerIds: readonly string[];
  runnerGroupId?: string;
}): void {
  const usesRunners = policy.runnerIds.length > 0;
  const usesGroup = Boolean(policy.runnerGroupId);
  if (usesRunners === usesGroup) {
    throw new DomainError(
      usesRunners ? "RUNNER_SELECTION_CONFLICT" : "RUNNER_SELECTION_REQUIRED",
      usesRunners
        ? "用例任务只能选择执行机或执行机组中的一种。"
        : "用例任务必须配置执行机或执行机组。",
    );
  }
}

function describeSuiteChange(input: UpdateCaseSuiteInput): string {
  const changes: string[] = [];
  if (input.name !== undefined) changes.push("rename");
  if (input.description !== undefined) changes.push("description");
  if (input.policy !== undefined) changes.push("policy");
  if (input.enabled !== undefined) changes.push(input.enabled ? "enable" : "disable");
  if (input.archived !== undefined) changes.push(input.archived ? "archive" : "unarchive");
  return `suite.update:${changes.join("+") || "noop"}`;
}
