import { createHash } from "node:crypto";
import { versionInitializationMemberCursorSchema } from "@autoforge/contracts";
import type { VersionInitializationInput, VersionInitializationResult } from "@autoforge/contracts";
import {
  DomainError,
  type DdtScope,
  type ProjectStructure,
  type TestStage,
} from "@autoforge/domain";
import type {
  CaseCatalogRepository,
  CaseSuiteRepository,
  Clock,
  DdtRepository,
  IdGenerator,
  ProjectStructureRepository,
} from "./ports";
import { CaseDefinitionService } from "./manage-case-definitions";
import { CaseSuiteService } from "./manage-case-suites";
import { inheritDdtCases } from "./inherit-ddt-cases";
import { inheritDdtConfigurationPage } from "./inherit-ddt-configuration";

type Version = ProjectStructure["versions"][number];
const MEMBER_PAGE_SIZE = 50;

export class VersionInitializationService {
  constructor(
    private readonly dependencies: {
      structures: ProjectStructureRepository;
      catalog: CaseCatalogRepository;
      suites: CaseSuiteRepository;
      ddt: DdtRepository;
      caseSuites: CaseSuiteService;
      clock: Clock;
      ids: IdGenerator;
    },
  ) {}

  async apply(
    projectId: string,
    targetVersionId: string,
    input: VersionInitializationInput,
    actorId?: string,
  ): Promise<VersionInitializationResult> {
    const { structures, catalog, ddt, clock, ids } = this.dependencies;
    const structure = await structures.list(projectId);
    const source = structure.versions.find(
      (version) => version.id === input.sourceProjectVersionId,
    );
    const target = structure.versions.find((version) => version.id === targetVersionId);
    if (!source || !target || source.id === target.id || target.status !== "active")
      throw new DomainError(
        "VERSION_INITIALIZATION_SCOPE_INVALID",
        "请选择同一项目内不同的来源版本和启用中的目标版本。",
      );
    if (input.step === "runtime") {
      const existing = target.adapterConfiguration;
      if (existing.jdkAsset || existing.jarBundleAsset)
        return skipped("目标版本已有运行依赖，已保留；如需更换，请在执行资源配置中操作。");
      if (!source.adapterConfiguration.jdkAsset && !source.adapterConfiguration.jarBundleAsset)
        return skipped("来源版本未配置 JDK 或依赖 JAR 压缩包。");
      await structures.inheritAdapterConfiguration({
        projectId,
        sourceProjectVersionId: source.id,
        targetProjectVersionId: target.id,
        expectedRevision: existing.revision,
        ...(actorId ? { actorId } : {}),
        updatedAt: clock.now().toISOString(),
      });
      return completed(1);
    }
    if (input.step === "suite") return this.inheritSuite(projectId, source, target, input, actorId);
    const sourceStage = source.stages.find(
      (stage) => stage.id === input.sourceTestStageId && stage.status === "active",
    );
    if (!sourceStage)
      throw new DomainError("VERSION_INITIALIZATION_STAGE_INVALID", "来源测试阶段不存在或已归档。");
    if (input.step === "stage") {
      const existing = matchInitializationStage(target.stages, sourceStage.name);
      if (existing) return { ...completed(0), skippedCount: 1, targetTestStageId: existing.id };
      try {
        const stage = await structures.createStage({
          id: ids.next(),
          projectId,
          projectVersionId: target.id,
          name: sourceStage.name,
          normalizedName: normalizeName(sourceStage.name),
          description: sourceStage.description,
          recordedAt: clock.now().toISOString(),
        });
        return { ...completed(1), targetTestStageId: stage.id };
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "PROJECT_STRUCTURE_NAME_CONFLICT")
          throw error;
        // A concurrent initializer may have created the same stage after our read.
        const updated = await structures.list(projectId);
        const current = updated.versions.find((version) => version.id === target.id);
        const matching = current && matchInitializationStage(current.stages, sourceStage.name);
        if (!matching) throw error;
        return { ...completed(0), skippedCount: 1, targetTestStageId: matching.id };
      }
    }
    const targetStage = target.stages.find(
      (stage) => stage.id === input.targetTestStageId && stage.status === "active",
    );
    if (!targetStage)
      throw new DomainError(
        "VERSION_INITIALIZATION_STAGE_INVALID",
        "请先选择或创建目标测试阶段；也可以跳过当前步骤。",
      );
    const sourceScope: DdtScope = {
      projectId,
      projectVersionId: source.id,
      testStageId: sourceStage.id,
    };
    const targetScope: DdtScope = {
      projectId,
      projectVersionId: target.id,
      testStageId: targetStage.id,
    };
    if (input.step === "testng")
      return {
        ...(await new CaseDefinitionService(catalog, clock, ids).inheritPage({
          projectId,
          sourceProjectVersionId: source.id,
          sourceTestStageId: sourceStage.id,
          targetProjectVersionId: target.id,
          targetTestStageId: targetStage.id,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(actorId ? { actorId } : {}),
        })),
        warnings: [],
      };
    if (input.step === "ddt")
      return {
        ...(await inheritDdtCases(
          ddt,
          clock,
          ids,
          targetScope,
          {
            sourceProjectVersionId: source.id,
            sourceTestStageId: sourceStage.id,
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
          `继承自 ${source.name} / ${sourceStage.name}`,
          actorId,
        )),
        warnings: [],
      };
    return inheritDdtConfigurationPage(
      ddt,
      clock,
      ids,
      sourceScope,
      targetScope,
      input.step,
      input.cursor,
    );
  }

  private async inheritSuite(
    projectId: string,
    source: Version,
    target: Version,
    input: VersionInitializationInput,
    actorId?: string,
  ): Promise<VersionInitializationResult> {
    const { suites, caseSuites, ddt } = this.dependencies;
    if (!input.sourceSuiteId || !input.sourceSuiteRevision)
      throw new DomainError("VERSION_INITIALIZATION_SUITE_REQUIRED", "请选择来源任务。");
    const cursor = parseMemberCursor(input.cursor);
    const mappedStages = new Set<string>();
    for (const mapping of input.stageMappings) {
      if (
        mappedStages.has(mapping.sourceTestStageId) ||
        !source.stages.some(
          (stage) => stage.id === mapping.sourceTestStageId && stage.status === "active",
        ) ||
        !target.stages.some(
          (stage) => stage.id === mapping.targetTestStageId && stage.status === "active",
        )
      )
        throw new DomainError(
          "VERSION_INITIALIZATION_STAGE_INVALID",
          "阶段映射重复或不属于所选版本的启用阶段。",
        );
      mappedStages.add(mapping.sourceTestStageId);
    }
    const targetSuiteId = inheritedSuiteId(input.sourceSuiteId, target.id);
    const suite = await caseSuites.inheritConfiguration({
      sourceSuiteId: input.sourceSuiteId,
      targetSuiteId,
      projectId,
      sourceProjectVersionId: source.id,
      targetProjectVersionId: target.id,
      sourceRevision: input.sourceSuiteRevision,
      ...(actorId ? { actorId } : {}),
    });
    if (suite.status === "archived" || suite.enabled)
      throw new DomainError(
        "VERSION_INITIALIZATION_SUITE_ACTIVE",
        "目标任务已启用或归档，不能继续初始化成员；请先在任务设置中停用。",
      );
    if (!input.includeCases) return { ...completed(1), targetSuiteId };
    const page = await suites.listMemberPage({
      suiteId: input.sourceSuiteId,
      projectIds: [projectId],
      limit: MEMBER_PAGE_SIZE,
      ...(cursor.afterCaseMemberId ? { afterCaseMemberId: cursor.afterCaseMemberId } : {}),
      ...(cursor.afterDdtMemberId ? { afterDdtMemberId: cursor.afterDdtMemberId } : {}),
    });
    if (!page) throw new DomainError("CASE_SUITE_NOT_FOUND", "来源任务不存在。");
    const result = { ...completed(0), targetSuiteId };
    const targetStageFor = (sourceStageId: string | undefined) => {
      const stage = source.stages.find((item) => item.id === sourceStageId);
      const explicit = input.stageMappings.find((item) => item.sourceTestStageId === sourceStageId);
      return explicit
        ? target.stages.find(
            (item) => item.id === explicit.targetTestStageId && item.status === "active",
          )
        : stage && matchInitializationStage(target.stages, stage.name);
    };
    const caseIds: string[] = [];
    for (const item of page.items) {
      const stage = targetStageFor(item.caseDefinition.testStageId);
      const candidate =
        stage &&
        (await ddt.findExecutionClass(
          { projectId, projectVersionId: target.id, testStageId: stage.id },
          item.caseDefinition.className,
        ));
      if (candidate) caseIds.push(candidate.caseDefinitionId);
      else recordMissing(result, item.caseDefinition.className);
    }
    const uniqueCaseIds = [...new Set(caseIds)];
    const existingCases = new Set(
      await suites.findMemberCaseDefinitionIds(targetSuiteId, uniqueCaseIds),
    );
    const additions = uniqueCaseIds.filter((id) => !existingCases.has(id));
    if (additions.length) await caseSuites.addCases(targetSuiteId, additions, actorId, [projectId]);
    result.inheritedCount += additions.length;
    result.skippedCount += existingCases.size + caseIds.length - uniqueCaseIds.length;
    const ddtCandidates = new Map<string, { stageId: string; caseId: string }>();
    for (const item of page.ddtItems ?? []) {
      const stage = targetStageFor(item.ddtCase.testStageId);
      const candidate =
        stage &&
        (await ddt.getCaseSummary(
          { projectId, projectVersionId: target.id, testStageId: stage.id },
          item.ddtCase.caseId,
        ));
      if (!candidate || !stage) {
        recordMissing(result, item.ddtCase.caseId);
        continue;
      }
      if (ddtCandidates.has(candidate.id)) result.skippedCount++;
      ddtCandidates.set(candidate.id, { stageId: stage.id, caseId: candidate.caseId });
    }
    const existingDdt = new Set(
      await suites.findMemberDdtCaseIds(targetSuiteId, [...ddtCandidates.keys()]),
    );
    const ddtAdditions = new Map<string, string[]>();
    for (const [id, candidate] of ddtCandidates) {
      if (existingDdt.has(id)) continue;
      const group = ddtAdditions.get(candidate.stageId) ?? [];
      group.push(candidate.caseId);
      ddtAdditions.set(candidate.stageId, group);
    }
    for (const [stageId, caseIds] of ddtAdditions)
      await caseSuites.addDdtCases(targetSuiteId, stageId, caseIds, actorId, [projectId]);
    result.inheritedCount += ddtCandidates.size - existingDdt.size;
    result.skippedCount += existingDdt.size;
    if (page.items.length === MEMBER_PAGE_SIZE || page.ddtItems?.length === MEMBER_PAGE_SIZE)
      result.nextCursor = JSON.stringify({
        afterCaseMemberId: page.items.at(-1)?.id ?? cursor.afterCaseMemberId,
        afterDdtMemberId: page.ddtItems?.at(-1)?.id ?? cursor.afterDdtMemberId,
      });
    return result;
  }
}

function parseMemberCursor(cursor: string | undefined) {
  if (!cursor) return {};
  try {
    return versionInitializationMemberCursorSchema.parse(JSON.parse(cursor));
  } catch (cause) {
    throw new DomainError(
      "VERSION_INITIALIZATION_CURSOR_INVALID",
      "任务继承游标无效，请重新选择任务。",
      { cause },
    );
  }
}

function recordMissing(result: VersionInitializationResult, name: string) {
  result.skippedCount++;
  if (result.warnings.length < 50)
    result.warnings.push(`${name.slice(0, 800)}：目标阶段中未找到可匹配用例，已跳过。`);
}
function completed(inheritedCount: number): VersionInitializationResult {
  return { inheritedCount, skippedCount: 0, warnings: [] };
}
function skipped(message: string): VersionInitializationResult {
  return { inheritedCount: 0, skippedCount: 1, warnings: [message] };
}
function normalizeName(name: string) {
  return name.trim().toLocaleLowerCase("en-US");
}
export function matchInitializationStage<T extends Pick<TestStage, "id" | "name" | "status">>(
  stages: T[],
  name: string,
): T | undefined {
  return stages.find(
    (stage) => stage.status === "active" && normalizeName(stage.name) === normalizeName(name),
  );
}
/** Stable application-generated UUIDv8 makes retried requests reuse the same target task. */
export function inheritedSuiteId(sourceSuiteId: string, targetVersionId: string): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(["version-initialization-v1", sourceSuiteId, targetVersionId]))
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
