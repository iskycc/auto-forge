import type {
  CopyCaseSuiteInput,
  CreateCaseSuiteInput,
  UpdateCaseSuiteInput,
} from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID, DomainError, mergeCaseSuiteExecutionPolicy } from "@autoforge/domain";

import type { CaseCatalogRepository, CaseSuiteRepository, Clock, IdGenerator } from "./ports";

export class CaseSuiteService {
  constructor(
    private readonly suites: CaseSuiteRepository,
    private readonly catalog: CaseCatalogRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async create(input: CreateCaseSuiteInput, actorId?: string) {
    const description = input.description?.trim();
    return this.suites.create({
      id: this.ids.next(),
      projectId: input.projectId ?? DEFAULT_PROJECT_ID,
      ...(actorId ? { actorId } : {}),
      name: input.name.trim(),
      ...(description ? { description } : {}),
      createdAt: this.clock.now().toISOString(),
    });
  }

  list(limit = 200, projectIds?: readonly string[]) {
    return this.suites.list(limit, projectIds);
  }

  async get(suiteId: string, projectIds?: readonly string[]) {
    const suite = await this.suites.get(suiteId, projectIds);
    if (!suite) throw new DomainError("CASE_SUITE_NOT_FOUND", "指定的用例任务不存在。");
    return suite;
  }

  async update(
    suiteId: string,
    input: UpdateCaseSuiteInput,
    actorId?: string,
    projectIds?: readonly string[],
  ) {
    const suite = await this.get(suiteId, projectIds);
    if (input.expectedRevision !== suite.revision) {
      throw new DomainError("CASE_SUITE_REVISION_CONFLICT", "用例任务已被他人修改，请刷新后重试。");
    }
    const name = input.name?.trim();
    const policy = input.policy
      ? mergeCaseSuiteExecutionPolicy(suite.policy, input.policy)
      : undefined;
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
    const suite = await this.get(suiteId, projectIds);
    const uniqueIds = [...new Set(requestedIds)];
    const existingIds = await this.catalog.findExistingCaseIds(uniqueIds, suite.projectId);
    if (existingIds.length !== uniqueIds.length) {
      throw new DomainError("CASE_DEFINITION_NOT_FOUND", "选择中包含不存在的用例。");
    }
    const currentIds = new Set(suite.items.map((item) => item.caseDefinition.id));
    const additions = existingIds.filter((id) => !currentIds.has(id));
    if (suite.items.length + additions.length > 500) {
      throw new DomainError("CASE_SUITE_CAPACITY_EXCEEDED", "单个用例任务最多包含 500 个用例。");
    }
    return this.suites.addCases({
      suiteId,
      items: additions.map((caseDefinitionId) => ({
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
    await this.get(suiteId, projectIds);
    return this.suites.removeCase({
      suiteId,
      caseDefinitionId,
      versionId: this.ids.next(),
      ...(actorId ? { actorId } : {}),
      updatedAt: this.clock.now().toISOString(),
    });
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
