import type { ProjectVersion, TestStage } from "@autoforge/domain";

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
  return {
    suiteName: projectName,
    testName: [version?.name, stage?.name].filter(Boolean).join(" - "),
  };
}
