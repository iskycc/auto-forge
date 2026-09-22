import type { DdtInheritancePage, InheritDdtCasesInput } from "@autoforge/contracts";
import { DomainError, type DdtScope } from "@autoforge/domain";
import type { Clock, DdtRepository, IdGenerator } from "./ports";

export async function inheritDdtCases(
  repository: Pick<DdtRepository, "inheritCasesPage">,
  clock: Clock,
  ids: IdGenerator,
  target: DdtScope,
  input: InheritDdtCasesInput,
  sourceName: string,
  actorId?: string,
): Promise<DdtInheritancePage> {
  if (input.sourceProjectVersionId === target.projectVersionId) {
    throw new DomainError(
      "DDT_INHERITANCE_SELF_REFERENCE",
      "请选择其他项目版本作为 DDT 用例继承来源。",
    );
  }
  return repository.inheritCasesPage({
    source: {
      projectId: target.projectId,
      projectVersionId: input.sourceProjectVersionId,
      testStageId: input.sourceTestStageId,
    },
    target,
    // The repository also bounds the window by stored body size. IDs are generated
    // here, so neither dialect needs database-specific ID generation.
    targetIds: Array.from({ length: 64 }, () => ids.next()),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    sourceName,
    ...(actorId ? { actorId } : {}),
    inheritedAt: clock.now().toISOString(),
  });
}
