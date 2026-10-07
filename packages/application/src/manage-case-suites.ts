import type {
  CopyCaseSuiteInput,
  CreateFailureCaseSuiteInput,
  CreateCaseSuiteInput,
  UpdateCaseSuiteInput,
  SetCaseSuitePinInput,
  RoundRecoveryCredentialSourcesPage,
} from "@autoforge/contracts";
import { roundRecoveryCredentialSourceCursorSchema } from "@autoforge/contracts";
import {
  DEFAULT_PROJECT_ID,
  DomainError,
  defaultCaseSuiteExecutionPolicy,
  mergeCaseSuiteExecutionPolicy,
  isTerminalRunBatchStatus,
  orderCaseSuitesByPins,
  failureCaseSuiteNameDate,
  formatFailureCaseSuiteName,
  type CaseSuiteExecutionPolicy,
  type CaseSuite,
  type RetryConcurrencyRule,
  type RoundRecoveryRule,
} from "@autoforge/domain";

import type {
  CaseCatalogRepository,
  CaseSuiteExportMemberType,
  CaseSuiteExportRow,
  CaseSuiteRepository,
  Clock,
  DdtRepository,
  FailureCaseSuiteNameRequest,
  FailureCaseSuiteSource,
  IdGenerator,
  ProjectStructureRepository,
  SecretCipherPort,
} from "./ports";
import {
  roundRecoverySecretPurpose,
  RoundRecoveryCredentialResolver,
} from "./round-recovery-credentials";

const CASE_SUITE_EXPORT_PAGE_SIZE = 1_000;

export class CaseSuiteService {
  constructor(
    private readonly suites: CaseSuiteRepository,
    private readonly catalog: CaseCatalogRepository,
    private readonly projectStructures: ProjectStructureRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly secretCipher?: SecretCipherPort,
    private readonly ddt?: DdtRepository,
    private readonly timeZone: () => string = () => "UTC",
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

  async listForUser(
    userId: string,
    limit = 200,
    projectIds?: readonly string[],
    projectVersionId?: string,
  ) {
    const items = await this.suites.list(limit, projectIds, projectVersionId, undefined, userId);
    const pinnedSuiteIds = await this.suites.listPinnedSuiteIds(
      userId,
      items.map((suite) => suite.id),
    );
    return { items: orderCaseSuitesByPins(items, new Set(pinnedSuiteIds)), pinnedSuiteIds };
  }

  async setPinned(
    suiteId: string,
    input: SetCaseSuitePinInput,
    userId: string,
    projectIds?: readonly string[],
  ) {
    const suite = await this.getSummary(suiteId, projectIds);
    await this.suites.setPinned({
      userId,
      suiteId: suite.id,
      pinned: input.pinned,
      createdAt: this.clock.now().toISOString(),
    });
    return { suiteId: suite.id, pinned: input.pinned };
  }

  async listVersionPage(projectId: string, projectVersionId: string, cursor?: string) {
    const rows = await this.suites.list(
      51,
      [projectId],
      projectVersionId,
      cursor ? { afterId: cursor } : {},
    );
    return { items: rows.slice(0, 50), ...(rows.length > 50 ? { nextCursor: rows[49]!.id } : {}) };
  }

  async get(suiteId: string, projectIds?: readonly string[]) {
    const suite = await this.suites.get(suiteId, projectIds);
    if (!suite) throw new DomainError("CASE_SUITE_NOT_FOUND", "指定的用例任务不存在。");
    return suite;
  }

  /** 只读任务摘要（不含用例成员）：授权与轻量校验入口不必加载全量成员。 */
  async getSummary(suiteId: string, projectIds?: readonly string[]) {
    const suite = await this.suites.getSummary(suiteId, projectIds);
    if (!suite) throw new DomainError("CASE_SUITE_NOT_FOUND", "指定的用例任务不存在。");
    return suite;
  }

  /**
   * 为 XLSX 导出提供轻量、游标分页的数据流。先读取任务摘要完成项目授权，之后按
   * 普通用例、DDT 用例的固定顺序输出，避免通过 get() 加载每个用例的测试方法。
   */
  async prepareCaseExport(suiteId: string, projectIds?: readonly string[]) {
    const suite = await this.getSummary(suiteId, projectIds);
    return {
      suite,
      rows: this.exportRows(suiteId, projectIds),
    };
  }

  private async *exportRows(
    suiteId: string,
    projectIds?: readonly string[],
  ): AsyncGenerator<CaseSuiteExportRow> {
    const memberTypes: readonly CaseSuiteExportMemberType[] = ["standard", "ddt"];
    for (const memberType of memberTypes) {
      let afterMemberId: string | undefined;
      while (true) {
        const page = await this.suites.listExportRowsPage({
          suiteId,
          memberType,
          limit: CASE_SUITE_EXPORT_PAGE_SIZE,
          ...(afterMemberId ? { afterMemberId } : {}),
          ...(projectIds ? { projectIds } : {}),
        });
        for (const row of page) yield row;
        if (page.length < CASE_SUITE_EXPORT_PAGE_SIZE) break;
        afterMemberId = page.at(-1)?.memberId;
        if (!afterMemberId) break;
      }
    }
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
      ? await this.preparePolicyUpdate(suite, input.policy, projectIds)
      : undefined;
    const policy = policyUpdate?.policy;
    if (policy) assertRunnableResourceSelection(policy);
    if (policy?.projectVersionId && policy.projectVersionId !== suite.policy.projectVersionId) {
      await this.resolveActiveProjectVersion(suite.projectId, policy.projectVersionId);
      const details = await this.get(suiteId, projectIds);
      if (
        details.items.some(
          (item) => item.caseDefinition.projectVersionId !== policy.projectVersionId,
        ) ||
        (details.ddtItems ?? []).some(
          (item) => item.ddtCase.projectVersionId !== policy.projectVersionId,
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
    const members = input.includeCases === false ? undefined : await this.get(suiteId, projectIds);
    const source = members ?? (await this.getSummary(suiteId, projectIds));
    const ddtMembers = members?.ddtItems ?? [];
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
      items: (members?.items ?? []).map((item) => ({
        id: this.ids.next(),
        caseDefinitionId: item.caseDefinition.id,
      })),
      ...(ddtMembers.length > 0
        ? {
            ddtItems: ddtMembers.map((item) => ({
              id: this.ids.next(),
              ddtCaseId: item.ddtCase.id,
            })),
          }
        : {}),
      versionId: this.ids.next(),
      ...(actorId ? { actorId } : {}),
      createdAt,
      ...(Object.keys(copiedRecovery.credentials).length > 0
        ? { roundRecoveryCredentials: copiedRecovery.credentials }
        : {}),
    });
  }

  async suggestFinalFailureName(batchId: string, projectIds?: readonly string[]) {
    const source = await this.finalFailureSource(batchId, projectIds);
    return { name: await this.suites.suggestFailureCopyName(this.failureCopyNameRequest(source)) };
  }

  private failureCopyNameRequest(
    source: FailureCaseSuiteSource & {
      policy: CaseSuiteExecutionPolicy & { projectVersionId: string };
    },
  ): FailureCaseSuiteNameRequest {
    return {
      sourceName: source.suiteName,
      date: failureCaseSuiteNameDate(this.clock.now(), this.timeZone()),
      projectId: source.projectId,
      projectVersionId: source.policy.projectVersionId,
    };
  }

  private async finalFailureSource(batchId: string, projectIds?: readonly string[]) {
    const source = await this.suites.getFailureCopySource(batchId, projectIds);
    if (!source) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
    if (!isTerminalRunBatchStatus(source.status)) {
      throw new DomainError("RUN_BATCH_NOT_TERMINAL", "执行任务完全结束后才能以失败用例创建任务。");
    }
    const projectVersionId = source.policy?.projectVersionId;
    if (
      !source.policy ||
      !projectVersionId ||
      source.kind === "case_log_rerun" ||
      source.suiteId.startsWith("single:")
    ) {
      throw new DomainError("RUN_RERUN_SOURCE_INVALID", "本次执行没有可复制的任务配置快照。");
    }
    await this.resolveActiveProjectVersion(source.projectId, projectVersionId);
    return { ...source, policy: { ...source.policy, projectVersionId } };
  }

  async createFromFinalFailures(
    batchId: string,
    input: CreateFailureCaseSuiteInput,
    actorId?: string,
    projectIds?: readonly string[],
  ) {
    const source = await this.finalFailureSource(batchId, projectIds);
    const sourcePolicy = source.policy;
    const projectVersionId = sourcePolicy.projectVersionId;
    const failureCopyName =
      input.name === undefined ? this.failureCopyNameRequest(source) : undefined;
    const selectedMembers = await this.finalFailureMembers(
      batchId,
      source.projectId,
      projectVersionId,
    );
    const suiteId = this.ids.next();
    const recovery = this.copyRoundRecoveryRules(
      source.suiteId,
      suiteId,
      sourcePolicy.roundRecoveryRules,
      source.roundRecoveryCredentials,
    );
    return this.suites.copySuite({
      id: suiteId,
      failureBatchId: batchId,
      projectId: source.projectId,
      name: failureCopyName ? formatFailureCaseSuiteName(failureCopyName) : input.name!.trim(),
      ...(failureCopyName ? { failureCopyName } : {}),
      ...(source.description ? { description: source.description } : {}),
      policy: mergeCaseSuiteExecutionPolicy(sourcePolicy, { roundRecoveryRules: recovery.rules }),
      items: [...selectedMembers.testng].map((caseDefinitionId) => ({
        id: this.ids.next(),
        caseDefinitionId,
      })),
      ddtItems: [...selectedMembers.ddt].map((ddtCaseId) => ({ id: this.ids.next(), ddtCaseId })),
      versionId: this.ids.next(),
      ...(actorId ? { actorId } : {}),
      createdAt: this.clock.now().toISOString(),
      roundRecoveryCredentials: recovery.credentials,
    });
  }

  private async finalFailureMembers(batchId: string, projectId: string, projectVersionId: string) {
    const selected = { testng: new Set<string>(), ddt: new Set<string>() };
    let afterRunId: string | undefined;
    let afterCreatedAt: string | undefined;
    const limit = 500;
    while (true) {
      const members = await this.suites.listFinalFailureMemberPage({
        batchId,
        projectId,
        projectVersionId,
        limit,
        ...(afterRunId ? { afterRunId } : {}),
        ...(afterCreatedAt ? { afterCreatedAt } : {}),
      });
      for (const member of members) {
        if (!member.available) {
          throw new DomainError(
            "CASE_SUITE_FAILURE_MEMBER_UNAVAILABLE",
            "失败用例中包含已删除、已回收或不属于原项目版本的用例，无法完整创建任务。",
          );
        }
        selected[member.caseType].add(member.caseId);
      }
      if (members.length < limit) break;
      afterRunId = members.at(-1)!.runId;
      afterCreatedAt = members.at(-1)!.createdAt;
    }
    if (selected.testng.size + selected.ddt.size === 0) {
      throw new DomainError("RUN_BATCH_NO_FINAL_FAILURES", "本次执行没有最终失败或超时的用例。");
    }
    return selected;
  }

  async inheritConfiguration(input: {
    sourceSuiteId: string;
    targetSuiteId: string;
    projectId: string;
    sourceProjectVersionId: string;
    targetProjectVersionId: string;
    sourceRevision: number;
    actorId?: string;
  }) {
    const source = await this.getSummary(input.sourceSuiteId, [input.projectId]);
    if (
      source.policy.projectVersionId !== input.sourceProjectVersionId ||
      source.revision !== input.sourceRevision
    )
      throw new DomainError(
        "CASE_SUITE_REVISION_CONFLICT",
        "来源任务已变更，请重新选择后继续初始化。",
      );
    await this.resolveActiveProjectVersion(input.projectId, input.targetProjectVersionId);
    const existing = await this.suites.getSummary(input.targetSuiteId, [input.projectId]);
    if (existing) return existing;
    const credentials = await this.suites.getRoundRecoveryCredentials(
      source.id,
      source.policy.roundRecoveryRules.map((rule) => rule.id),
    );
    const recovery = this.copyRoundRecoveryRules(
      source.id,
      input.targetSuiteId,
      source.policy.roundRecoveryRules,
      credentials,
    );
    return this.suites.copySuite({
      id: input.targetSuiteId,
      ifAbsent: true,
      enabled: false,
      projectId: input.projectId,
      name: source.name,
      ...(source.description ? { description: source.description } : {}),
      policy: mergeCaseSuiteExecutionPolicy(source.policy, {
        projectVersionId: input.targetProjectVersionId,
        roundRecoveryRules: recovery.rules,
        adapter: { ...source.policy.adapter, suiteName: "", testName: "" },
      }),
      items: [],
      versionId: this.ids.next(),
      ...(input.actorId ? { actorId: input.actorId } : {}),
      createdAt: this.clock.now().toISOString(),
      roundRecoveryCredentials: recovery.credentials,
    });
  }

  private async preparePolicyUpdate(
    suite: CaseSuite,
    input: NonNullable<UpdateCaseSuiteInput["policy"]>,
    projectIds?: readonly string[],
  ): Promise<{ policy: CaseSuiteExecutionPolicy; credentialUpserts: Record<string, string> }> {
    const { retryConcurrencyRules, roundRecoveryRules, ...baseInput } = input;
    const normalizedRetryRules = retryConcurrencyRules?.map(normalizeRetryConcurrencyRule);
    const normalizedRecovery = roundRecoveryRules
      ? await this.prepareRoundRecoveryRules(suite, roundRecoveryRules, projectIds)
      : undefined;
    const policy = mergeCaseSuiteExecutionPolicy(suite.policy, {
      ...baseInput,
      ...(normalizedRetryRules ? { retryConcurrencyRules: normalizedRetryRules } : {}),
      ...(normalizedRecovery ? { roundRecoveryRules: normalizedRecovery.rules } : {}),
    });
    assertRetryOrchestrationPolicy(policy);
    return { policy, credentialUpserts: normalizedRecovery?.credentialUpserts ?? {} };
  }

  private async prepareRoundRecoveryRules(
    suite: CaseSuite,
    input: NonNullable<NonNullable<UpdateCaseSuiteInput["policy"]>["roundRecoveryRules"]>,
    projectIds?: readonly string[],
  ): Promise<{ rules: RoundRecoveryRule[]; credentialUpserts: Record<string, string> }> {
    const credentialUpserts = await new RoundRecoveryCredentialResolver(
      this.suites,
      this.secretCipher,
    ).prepare(suite, input, projectIds);
    const rules = input.map((rule): RoundRecoveryRule => {
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

  async listRoundRecoveryCredentialSources(
    suiteId: string,
    input: { query?: string | undefined; cursor?: string | undefined },
    projectIds?: readonly string[],
  ): Promise<RoundRecoveryCredentialSourcesPage> {
    await this.getSummary(suiteId, projectIds);
    let after: { suiteId: string; ruleId: string } | undefined;
    if (input.cursor) {
      try {
        after = roundRecoveryCredentialSourceCursorSchema.parse(JSON.parse(input.cursor));
      } catch (cause) {
        throw new DomainError("INVALID_CURSOR", "密钥来源分页游标无效。", { cause });
      }
    }
    const rows = await this.suites.listRoundRecoveryCredentialSources({
      limit: 51,
      excludeSuiteId: suiteId,
      ...(input.query ? { query: input.query } : {}),
      ...(after ? { after } : {}),
      ...(projectIds ? { projectIds } : {}),
    });
    const items = rows.slice(0, 50);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > 50 && last
        ? { nextCursor: JSON.stringify({ suiteId: last.suiteId, ruleId: last.ruleId }) }
        : {}),
    };
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

  async addDdtCases(
    suiteId: string,
    testStageId: string,
    requestedIds: string[],
    actorId?: string,
    projectIds?: readonly string[],
  ) {
    const { caseIds } = await this.validateDdtSelection(
      suiteId,
      testStageId,
      requestedIds,
      projectIds,
    );
    return this.suites.addDdtCases({
      suiteId,
      items: caseIds.map((ddtCaseId) => ({ id: this.ids.next(), ddtCaseId })),
      versionId: this.ids.next(),
      ...(actorId ? { actorId } : {}),
      updatedAt: this.clock.now().toISOString(),
    });
  }

  async removeDdtCases(
    suiteId: string,
    requestedIds: string[],
    actorId?: string,
    projectIds?: readonly string[],
  ) {
    await this.getSummary(suiteId, projectIds);
    const caseIds = [...new Set(requestedIds.map((id) => id.trim()).filter(Boolean))];
    if (caseIds.length === 0) {
      throw new DomainError("CASE_SUITE_SELECTION_INVALID", "请至少选择一个 DDT 用例。");
    }
    return this.suites.removeDdtCases({
      suiteId,
      ddtCaseIds: caseIds,
      versionId: this.ids.next(),
      ...(actorId ? { actorId } : {}),
      updatedAt: this.clock.now().toISOString(),
    });
  }

  private async validateDdtSelection(
    suiteId: string,
    testStageId: string,
    requestedIds: string[],
    projectIds?: readonly string[],
  ): Promise<{ caseIds: string[] }> {
    const suite = await this.getSummary(suiteId, projectIds);
    const projectVersionId = suite.policy.projectVersionId;
    if (!projectVersionId) {
      throw new DomainError(
        "CASE_SUITE_VERSION_REQUIRED",
        "历史任务尚未关联项目版本，请先在任务设置中选择版本。",
      );
    }
    const requestedCaseIds = [...new Set(requestedIds.map((id) => id.trim()).filter(Boolean))];
    if (requestedCaseIds.length === 0) {
      throw new DomainError("CASE_SUITE_SELECTION_INVALID", "请至少选择一个 DDT 用例。");
    }
    const cases = await this.requireDdtRepository().getCases(
      { projectId: suite.projectId, projectVersionId, testStageId },
      requestedCaseIds,
    );
    if (cases.length !== requestedCaseIds.length) {
      throw new DomainError(
        "DDT_CASE_VERSION_MISMATCH",
        "选择中包含不存在或不属于任务项目版本、测试阶段的 DDT 用例。",
      );
    }
    return { caseIds: cases.map((item) => item.id) };
  }

  private requireDdtRepository(): DdtRepository {
    if (!this.ddt) throw new Error("DDT repository is not configured for case-suite management.");
    return this.ddt;
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
    executionRound: rule.executionRound,
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
  if (policy.retryConcurrencyRules.some((rule) => rule.executionRound > maximumExecutionRound)) {
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
