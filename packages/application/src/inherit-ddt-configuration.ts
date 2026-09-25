import type { VersionInitializationResult } from "@autoforge/contracts";
import type { DdtScope } from "@autoforge/domain";
import type { Clock, DdtRepository, IdGenerator } from "./ports";
import { DdtCaseService } from "./manage-ddt-cases";

const PAGE_SIZE = 20;
const normalize = (name: string) => name.trim().toLocaleLowerCase("en-US");

/** Each request copies one bounded window; existing target configuration is never replaced. */
export async function inheritDdtConfigurationPage(
  repository: DdtRepository,
  clock: Clock,
  ids: IdGenerator,
  source: DdtScope,
  target: DdtScope,
  step: "range" | "categories" | "sr",
  cursor?: string,
): Promise<VersionInitializationResult> {
  const service = new DdtCaseService(repository, clock, ids);
  const query = { query: "", limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) };
  const result: VersionInitializationResult = { inheritedCount: 0, skippedCount: 0, warnings: [] };
  function skip(label: string, reason?: string) {
    result.skippedCount++;
    if (reason) result.warnings.push(`${label.slice(0, 500)}：${reason}`);
  }
  async function includeClass(className: string) {
    const candidate = await repository.findExecutionClass(target, className);
    if (!candidate?.enabled || candidate.archived) return false;
    const range = await repository.listExecutionClassRange(target, { query: className, limit: 50 });
    if (!range.items.some((item) => item.caseDefinitionId === candidate.caseDefinitionId))
      await service.changeExecutionClassRange(target, {
        caseDefinitionId: candidate.caseDefinitionId,
        className,
        included: true,
        expectedRevision: range.revision,
      });
    return true;
  }
  if (step === "range") {
    const page = await repository.listExecutionClassRange(source, query);
    for (const item of page.items) {
      if (await includeClass(item.className)) result.inheritedCount++;
      else skip(item.className, "目标阶段没有可用的同名测试类，请先继承普通用例。");
    }
    return { ...result, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  if (step === "categories") {
    const page = await repository.listRequirementCategories(source, query);
    for (const item of page.items) {
      const candidates = await repository.listRequirementCategories(target, {
        query: "",
        exactName: item.name,
        limit: 1,
      });
      if (
        candidates.items.some((candidate) => normalize(candidate.name) === normalize(item.name))
      ) {
        skip(item.name, "目标已有同名分类，保留原配置。");
        continue;
      }
      if (!item.executionClass || !(await includeClass(item.executionClass.className))) {
        skip(item.name, "目标阶段缺少对应测试类，未创建分类。");
        continue;
      }
      await service.saveRequirementCategory(target, {
        name: item.name,
        className: item.executionClass.className,
        expectedRevision: 0,
      });
      result.inheritedCount++;
    }
    return { ...result, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  const page = await repository.listSrExecutionMappings(source, query);
  for (const mapping of page.items) {
    if (mapping.legacyConflict) {
      skip(mapping.srNum, "来源存在旧关联冲突，请人工确认。");
      continue;
    }
    if (!mapping.executionClass) {
      skip(mapping.srNum);
      continue;
    }
    const targetPage = await repository.listSrExecutionMappings(target, {
      query: mapping.srNum,
      limit: 100,
    });
    const existing = targetPage.items.find(
      (item) => normalize(item.srNum) === normalize(mapping.srNum),
    );
    if (!existing) {
      skip(mapping.srNum, "目标阶段没有此 SR，请先继承 DDT 用例。");
      continue;
    }
    if (existing.executionClass || existing.category || existing.legacyConflict) {
      skip(mapping.srNum, "目标已有配置，保留原关联。");
      continue;
    }
    if (!(await includeClass(mapping.executionClass.className))) {
      skip(mapping.srNum, "目标阶段缺少对应测试类。");
      continue;
    }
    if (mapping.category) {
      const categories = await repository.listRequirementCategories(target, {
        query: "",
        exactName: mapping.category.name,
        limit: 1,
      });
      const category = categories.items.find(
        (item) => normalize(item.name) === normalize(mapping.category!.name),
      );
      if (!category || category.executionClass?.className !== mapping.executionClass.className) {
        skip(mapping.srNum, "目标分类缺失或执行类不同，请人工选择分类。");
        continue;
      }
      await service.setSrCategory(target, {
        srNum: existing.srNum,
        categoryId: category.id,
        expectedRevision: existing.revision,
      });
    } else {
      await service.setSrExecutionClass(target, {
        srNum: existing.srNum,
        className: mapping.executionClass.className,
        expectedRevision: existing.revision,
      });
    }
    result.inheritedCount++;
  }
  return { ...result, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}
