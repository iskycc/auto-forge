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

  async listVersions(caseDefinitionId: string, projectIds?: readonly string[]) {
    await this.get(caseDefinitionId, projectIds);
    return this.catalog.listCaseVersions(caseDefinitionId, VERSION_HISTORY_LIMIT);
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
