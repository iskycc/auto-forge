import type { DdtCaseListInput, DdtCellValue, UpsertDdtTemplateInput } from "@autoforge/contracts";
import {
  DomainError,
  diffDdtCaseData,
  normalizeDdtCaseData,
  updateDdtCaseField,
  validateDdtCaseAgainstTemplate,
  type DdtCase,
  type DdtCaseData,
  type DdtExecutionClass,
  type DdtScope,
} from "@autoforge/domain";

import type { Clock, DdtRepository, IdGenerator } from "./ports";

export class DdtCaseService {
  constructor(
    private readonly repository: DdtRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  list(input: DdtCaseListInput) {
    return this.repository.listCases({
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      testStageId: input.testStageId,
      ...(input.query ? { query: input.query } : {}),
      ...(input.srNum ? { srNum: input.srNum } : {}),
      ...(input.sourceName ? { sourceName: input.sourceName } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: input.limit,
      filters: input.filters,
    });
  }

  groups(scope: DdtScope, query?: string, limit = 100) {
    return this.repository.listGroups(scope, query, limit);
  }

  dashboard(scope: DdtScope) {
    return this.repository.dashboard(scope);
  }

  executionClasses(scope: DdtScope, query?: string, limit = 50) {
    return this.repository.listExecutionClasses(scope, query, limit);
  }

  async setExecutionClass(
    scope: DdtScope,
    caseIds: readonly string[],
    className: string,
    actorId?: string,
  ): Promise<{ updatedCount: number; executionClass: DdtExecutionClass }> {
    const uniqueIds = normalizedIds(caseIds);
    const [cases, executionClass] = await Promise.all([
      this.repository.getCases(scope, uniqueIds),
      this.repository.findExecutionClass(scope, className),
    ]);
    if (cases.length !== uniqueIds.length) {
      throw new DomainError("DDT_CASE_NOT_FOUND", "批量选择中包含不存在的 DDT 用例。");
    }
    if (!executionClass) {
      throw new DomainError(
        "DDT_EXECUTION_CLASS_NOT_FOUND",
        "执行类不存在，或不属于当前项目版本和测试阶段的有效用例来源。",
      );
    }
    if (!executionClass.enabled || executionClass.archived) {
      throw new DomainError("DDT_EXECUTION_CLASS_UNAVAILABLE", "所选执行类当前不可执行。");
    }
    const updatedCount = await this.repository.setExecutionClass({
      scope,
      caseIds: uniqueIds,
      executionCaseDefinitionId: executionClass.caseDefinitionId,
      ...(actorId ? { actorId } : {}),
      updatedAt: this.clock.now().toISOString(),
    });
    if (updatedCount !== uniqueIds.length) {
      throw new DomainError(
        "DDT_EXECUTION_CLASS_UPDATE_CONFLICT",
        "部分 DDT 用例已被删除或移出当前范围，请刷新后重试。",
      );
    }
    return { updatedCount, executionClass };
  }

  async get(scope: DdtScope, caseId: string): Promise<DdtCase> {
    const item = await this.repository.getCase(scope, caseId.trim());
    if (!item) throw new DomainError("DDT_CASE_NOT_FOUND", "指定的 DDT 用例不存在。");
    return item;
  }

  async update(
    scope: DdtScope,
    caseId: string,
    expectedRevision: number,
    nextInput: DdtCaseData,
    actorId?: string,
  ): Promise<DdtCase> {
    const current = await this.get(scope, caseId);
    if (current.revision !== expectedRevision) {
      throw new DomainError("DDT_CASE_REVISION_CONFLICT", "DDT 用例已被他人修改，请刷新后重试。");
    }
    const template = await this.repository.getTemplateForSrNum(
      scope,
      String(nextInput.srNum ?? current.srNum),
    );
    const validated = validateDdtCaseAgainstTemplate(nextInput, template);
    if (validated.errors.length > 0) {
      throw new DomainError(
        "DDT_TEMPLATE_VALIDATION_FAILED",
        validated.errors.map((issue) => issue.message).join("；"),
      );
    }
    const changes = diffDdtCaseData(current.data, validated.data);
    if (changes.length === 0) return current;
    const updatedAt = this.clock.now().toISOString();
    const [updated] = await this.repository.updateCases([
      {
        scope,
        caseId: current.caseId,
        expectedRevision,
        nextData: validated.data,
        historyId: this.ids.next(),
        historyType: "edit",
        sourceName: "DDT 管理编辑",
        ...(actorId ? { actorId } : {}),
        updatedAt,
      },
    ]);
    if (!updated) throw new Error("DDT case update returned no record.");
    return updated;
  }

  async bulkUpdate(
    scope: DdtScope,
    caseIds: readonly string[],
    field: string,
    value: DdtCellValue,
    stepName?: string,
    actorId?: string,
  ): Promise<{ updatedCount: number }> {
    const uniqueIds = normalizedIds(caseIds);
    const currentCases = await this.repository.getCases(scope, uniqueIds);
    if (currentCases.length !== uniqueIds.length) {
      throw new DomainError("DDT_CASE_NOT_FOUND", "批量选择中包含不存在的 DDT 用例。");
    }
    const templates = new Map(
      (await this.repository.listTemplates(scope)).map((template) => [
        template.srNum.toLocaleLowerCase("en-US"),
        template,
      ]),
    );
    const updatedAt = this.clock.now().toISOString();
    const records = currentCases.flatMap((current) => {
      const next = updateDdtCaseField(current.data, field, value, stepName);
      const template = templates.get(String(next.srNum ?? "").toLocaleLowerCase("en-US"));
      const validated = validateDdtCaseAgainstTemplate(next, template);
      if (validated.errors.length > 0) {
        throw new DomainError(
          "DDT_TEMPLATE_VALIDATION_FAILED",
          `${current.caseId}：${validated.errors.map((issue) => issue.message).join("；")}`,
        );
      }
      return diffDdtCaseData(current.data, validated.data).length === 0
        ? []
        : [
            {
              scope,
              caseId: current.caseId,
              expectedRevision: current.revision,
              nextData: validated.data,
              historyId: this.ids.next(),
              historyType: "bulk_edit" as const,
              sourceName: "DDT 批量修改",
              ...(actorId ? { actorId } : {}),
              updatedAt,
            },
          ];
    });
    if (records.length === 0) return { updatedCount: 0 };
    const updated = await this.repository.updateCases(records);
    return { updatedCount: updated.length };
  }

  async trash(scope: DdtScope, caseIds: readonly string[], actorId?: string) {
    const uniqueIds = normalizedIds(caseIds);
    const deletedAt = this.clock.now().toISOString();
    return this.repository.trashCases({
      scope,
      caseIds: uniqueIds,
      recycleIds: uniqueIds.map(() => this.ids.next()),
      ...(actorId ? { actorId } : {}),
      deletedAt,
    });
  }

  listDeleted(scope: DdtScope, query?: string, cursor?: string, limit = 60) {
    return this.repository.listDeletedCases({
      ...scope,
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    });
  }

  restoreDeleted(scope: DdtScope, recycleId: string, actorId?: string) {
    return this.repository.restoreDeletedCase({
      scope,
      recycleId,
      restoredAt: this.clock.now().toISOString(),
      ...(actorId ? { actorId } : {}),
    });
  }

  async purgeDeleted(scope: DdtScope, recycleId: string): Promise<void> {
    if (!(await this.repository.purgeDeletedCase(scope, recycleId))) {
      throw new DomainError("DDT_RECYCLE_NOT_FOUND", "回收站记录不存在。");
    }
  }

  history(scope: DdtScope, caseId: string, cursor?: string, limit = 30) {
    return this.repository.listHistory({
      ...scope,
      caseId,
      ...(cursor ? { cursor } : {}),
      limit,
    });
  }

  async restoreHistory(
    scope: DdtScope,
    caseId: string,
    historyId: string,
    snapshot: "before" | "after",
    actorId?: string,
  ): Promise<DdtCase> {
    const [current, history] = await Promise.all([
      this.get(scope, caseId),
      this.repository.getHistory(scope, caseId, historyId),
    ]);
    if (!history) throw new DomainError("DDT_HISTORY_NOT_FOUND", "历史版本不存在。");
    const target = normalizeDdtCaseData(snapshot === "after" ? history.after : history.before);
    const template = await this.repository.getTemplateForSrNum(scope, String(target.srNum ?? ""));
    const validated = validateDdtCaseAgainstTemplate(target, template, false);
    if (validated.errors.length > 0) {
      throw new DomainError(
        "DDT_TEMPLATE_VALIDATION_FAILED",
        validated.errors.map((issue) => issue.message).join("；"),
      );
    }
    const [restored] = await this.repository.updateCases([
      {
        scope,
        caseId: current.caseId,
        expectedRevision: current.revision,
        nextData: validated.data,
        historyId: this.ids.next(),
        historyType: "restore",
        sourceName: `历史版本恢复 ${historyId}（${snapshot === "after" ? "修改后" : "修改前"}）`,
        ...(actorId ? { actorId } : {}),
        updatedAt: this.clock.now().toISOString(),
      },
    ]);
    if (!restored) throw new Error("DDT history restore returned no record.");
    return restored;
  }

  templates(scope: DdtScope) {
    return this.repository.listTemplates(scope);
  }

  writeTemplate(
    scope: DdtScope,
    input: UpsertDdtTemplateInput,
    templateId?: string,
    actorId?: string,
  ) {
    const now = this.clock.now().toISOString();
    return this.repository.writeTemplate({
      ...scope,
      id: templateId ?? this.ids.next(),
      ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
      srNum: input.srNum,
      name: input.name,
      description: input.description,
      rules: input.rules.map((rule) => ({
        field: rule.field,
        required: rule.required,
        type: rule.type,
        ...(rule.enumValues ? { enumValues: rule.enumValues } : {}),
        ...(rule.defaultValue !== undefined ? { defaultValue: rule.defaultValue } : {}),
      })),
      ...(actorId ? { actorId } : {}),
      now,
    });
  }

  async deleteTemplate(
    scope: DdtScope,
    templateId: string,
    expectedRevision: number,
  ): Promise<void> {
    if (!(await this.repository.deleteTemplate(scope, templateId, expectedRevision))) {
      throw new DomainError(
        "DDT_TEMPLATE_REVISION_CONFLICT",
        "字段模板不存在或已被他人修改，请刷新后重试。",
      );
    }
  }

  export(scope: DdtScope, selection: { caseIds?: string[]; srNum?: string }) {
    return this.repository.exportCases({ ...scope, ...selection });
  }
}

function normalizedIds(values: readonly string[]): string[] {
  const ids = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (ids.length === 0)
    throw new DomainError("DDT_SELECTION_REQUIRED", "请至少选择一个 DDT 用例。");
  return ids;
}
