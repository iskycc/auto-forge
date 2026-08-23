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
} from "@autoforge/domain";

import type {
  CaseCatalogRepository,
  CaseSuiteRepository,
  Clock,
  IdGenerator,
  ProjectStructureRepository,
} from "./ports";

export class CaseSuiteService {
  constructor(
    private readonly suites: CaseSuiteRepository,
    private readonly catalog: CaseCatalogRepository,
    private readonly projectStructures: ProjectStructureRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
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
    const policy = input.policy
      ? mergeCaseSuiteExecutionPolicy(suite.policy, input.policy)
      : undefined;
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
    return this.suites.copySuite({
      id: this.ids.next(),
      projectId: source.projectId,
      name: input.name.trim(),
      ...(source.description ? { description: source.description } : {}),
      policy: mergeCaseSuiteExecutionPolicy(source.policy, {}),
      items: source.items.map((item) => ({
        id: this.ids.next(),
        caseDefinitionId: item.caseDefinition.id,
      })),
      versionId: this.ids.next(),
      ...(actorId ? { actorId } : {}),
      createdAt,
    });
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
