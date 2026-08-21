import type { UpdateCaseDefinitionInput } from "@autoforge/contracts";
import { testNgClassCandidateSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

import type { CaseCatalogRepository, Clock, IdGenerator } from "./ports";

const VERSION_HISTORY_LIMIT = 100;

export class CaseDefinitionService {
  constructor(
    private readonly catalog: CaseCatalogRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async get(caseDefinitionId: string, projectIds?: readonly string[]) {
    const definition = await this.catalog.getCaseDefinition(caseDefinitionId, projectIds);
    if (!definition) throw new DomainError("CASE_DEFINITION_NOT_FOUND", "指定的用例不存在。");
    return definition;
  }

  async update(
    caseDefinitionId: string,
    input: UpdateCaseDefinitionInput,
    actorId: string,
    projectIds?: readonly string[],
  ) {
    const definition = await this.get(caseDefinitionId, projectIds);
    if (input.expectedRevision !== definition.revision) {
      throw new DomainError(
        "CASE_DEFINITION_REVISION_CONFLICT",
        "用例已被并发修改，请刷新后重试。",
      );
    }
    return this.catalog.updateCaseDefinition({
      caseDefinitionId,
      expectedRevision: input.expectedRevision,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      actorId,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  async deleteMany(caseDefinitionIds: readonly string[], projectIds?: readonly string[]) {
    const uniqueIds = [...new Set(caseDefinitionIds)];
    if (uniqueIds.length === 0) {
      throw new DomainError("CASE_DEFINITION_IDS_REQUIRED", "请至少选择一个要删除的用例。");
    }
    const deleted = await this.catalog.deleteCaseDefinitions(uniqueIds, projectIds);
    if (deleted.length !== uniqueIds.length) {
      throw new DomainError(
        "CASE_DEFINITION_NOT_FOUND",
        "部分用例不存在或不在当前账号可管理的项目范围内，未执行删除。",
      );
    }
    return deleted;
  }

  async listVersions(caseDefinitionId: string, projectIds?: readonly string[]) {
    await this.get(caseDefinitionId, projectIds);
    return this.catalog.listCaseVersions(caseDefinitionId, VERSION_HISTORY_LIMIT);
  }

  async listActivity(caseDefinitionId: string, projectIds?: readonly string[], limit = 50) {
    await this.get(caseDefinitionId, projectIds);
    return this.catalog.listCaseActivity
      ? this.catalog.listCaseActivity(caseDefinitionId, Math.max(1, Math.min(limit, 100)))
      : { executions: [], analyses: [] };
  }

  /**
   * 批量查询每个用例最近一次终态执行结果；`projectIds` 用于按项目范围裁剪，
   * 调用方已持有范围化用例 ID 时可省略。无终态记录的用例不出现在结果中。
   */
  async latestRunOutcomes(caseDefinitionIds: readonly string[], projectIds?: readonly string[]) {
    if (caseDefinitionIds.length === 0) return [];
    let scopedIds: readonly string[] = caseDefinitionIds;
    if (projectIds && projectIds.length > 0) {
      const existing = new Set<string>();
      for (const projectId of projectIds) {
        for (const id of await this.catalog.findExistingCaseIds(
          [...caseDefinitionIds],
          projectId,
        )) {
          existing.add(id);
        }
      }
      scopedIds = [...caseDefinitionIds].filter((id) => existing.has(id));
      if (scopedIds.length === 0) return [];
    }
    return this.catalog.listLatestRunOutcomes(scopedIds);
  }

  /**
   * 从不可变历史版本创建新的当前版本：执行内容（分组、参数、方法）恢复到
   * 快照状态，展示元数据（名称、描述、标签）保持不变。
   */
  async restoreVersion(
    caseDefinitionId: string,
    version: number,
    actorId: string,
    projectIds?: readonly string[],
  ) {
    const definition = await this.get(caseDefinitionId, projectIds);
    if (version === definition.currentVersion) {
      throw new DomainError("CASE_VERSION_ALREADY_CURRENT", "该版本已经是当前版本。");
    }
    const caseVersion = await this.catalog.getCaseVersion(caseDefinitionId, version);
    if (!caseVersion) {
      throw new DomainError("CASE_VERSION_NOT_FOUND", "指定的用例版本不存在。");
    }
    const snapshot = testNgClassCandidateSchema.safeParse(caseVersion.snapshot);
    if (!snapshot.success) {
      throw new DomainError("CASE_VERSION_SNAPSHOT_INVALID", "历史版本快照已损坏，无法恢复。");
    }
    return this.catalog.restoreCaseVersion({
      caseDefinitionId,
      expectedRevision: definition.revision,
      versionId: this.ids.next(),
      version: definition.currentVersion + 1,
      sourceId: caseVersion.sourceId,
      snapshot: snapshot.data,
      changeReason: "manual.restore",
      methodIds: snapshot.data.methods.map(() => this.ids.next()),
      actorId,
      restoredAt: this.clock.now().toISOString(),
    });
  }
}
