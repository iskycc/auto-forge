import {
  assessRunnerCompatibility,
  DomainError,
  REQUIRED_EXECUTION_LABELS,
  runnerAuthenticationBlock,
} from "@autoforge/domain";
import type { RunnerRepository } from "./ports";

const AUTOMATIC_RUNNER_POOL_SIZE = 64;

export async function automaticExecutionRunnerIds(
  runners: Pick<RunnerRepository, "listPage">,
  offlineBefore: string,
  requiredCapabilities: readonly string[],
): Promise<string[]> {
  const selected: string[] = [];
  let afterId: string | undefined;
  do {
    const page = await runners.listPage(offlineBefore, {
      ...(afterId ? { afterId } : {}),
      limit: AUTOMATIC_RUNNER_POOL_SIZE,
    });
    for (const runner of page.items) {
      if (runner.state !== "online" || runnerAuthenticationBlock(runner)) continue;
      if (!assessRunnerCompatibility(runner).compatible) continue;
      if (!REQUIRED_EXECUTION_LABELS.every((label) => runner.labels.includes(label))) continue;
      if (!requiredCapabilities.every((capability) => runner.capabilities.includes(capability)))
        continue;
      selected.push(runner.id);
      if (selected.length === AUTOMATIC_RUNNER_POOL_SIZE) return selected;
    }
    afterId = page.nextCursor;
  } while (afterId);
  if (selected.length === 0) {
    throw new DomainError(
      "RUNNER_AUTO_SELECTION_EMPTY",
      "未找到在线、兼容且具备本次执行能力的执行机，请检查节点或显式指定执行机/执行机组。",
    );
  }
  return selected;
}
