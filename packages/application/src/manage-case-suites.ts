import type { CreateCaseSuiteInput } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

import type { CaseCatalogRepository, CaseSuiteRepository, Clock, IdGenerator } from "./ports";

export class CaseSuiteService {
  constructor(
    private readonly suites: CaseSuiteRepository,
    private readonly catalog: CaseCatalogRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async create(input: CreateCaseSuiteInput) {
    const description = input.description?.trim();
    return this.suites.create({
      id: this.ids.next(),
      name: input.name.trim(),
      ...(description ? { description } : {}),
      createdAt: this.clock.now().toISOString(),
    });
  }

  list(limit = 200) {
    return this.suites.list(limit);
  }

  async get(suiteId: string) {
    const suite = await this.suites.get(suiteId);
    if (!suite) throw new DomainError("CASE_SUITE_NOT_FOUND", "指定的用例任务不存在。");
    return suite;
  }

  async addCases(suiteId: string, requestedIds: string[]) {
    const suite = await this.get(suiteId);
    const uniqueIds = [...new Set(requestedIds)];
    const existingIds = await this.catalog.findExistingCaseIds(uniqueIds);
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
      updatedAt: this.clock.now().toISOString(),
    });
  }

  async removeCase(suiteId: string, caseDefinitionId: string) {
    await this.get(suiteId);
    return this.suites.removeCase({
      suiteId,
      caseDefinitionId,
      updatedAt: this.clock.now().toISOString(),
    });
  }
}
