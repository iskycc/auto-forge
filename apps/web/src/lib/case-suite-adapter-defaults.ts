import type { ProjectVersion, TestStage } from "@autoforge/domain";
import { executionAdapterNameDefaults } from "@autoforge/domain";

// Execution entrypoints share the CoTest runtime and name defaults.
export { DEFAULT_EXECUTION_ADAPTER_ENABLED } from "@autoforge/domain";

export type AdapterNameDefaults = { suiteName: string; testName: string };

type VersionWithStages = Pick<ProjectVersion, "name"> & {
  stages: readonly Pick<TestStage, "id" | "name" | "status">[];
};

export function caseSuiteAdapterDefaults(
  projectName: string,
  version: VersionWithStages | undefined,
  selectedTestStageId?: string,
): AdapterNameDefaults {
  const activeStages = version?.stages.filter((stage) => stage.status === "active") ?? [];
  // A task can be opened from a link while the top bar points to another version.
  const stage = activeStages.find((stage) => stage.id === selectedTestStageId) ?? activeStages[0];
  return executionAdapterNameDefaults(projectName, version?.name, stage?.name);
}
