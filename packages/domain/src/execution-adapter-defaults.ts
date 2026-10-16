// New execution entrypoints use these defaults; saved snapshots retain their choices.
export const DEFAULT_EXECUTION_ADAPTER_ENABLED = true;

export function executionAdapterNameDefaults(
  projectName: string,
  versionName?: string,
  testStageName?: string,
): { suiteName: string; testName: string } {
  return {
    suiteName: projectName,
    testName: [versionName, testStageName].filter(Boolean).join(" - "),
  };
}
