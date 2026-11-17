// All new execution entrypoints use CoTest; historical execution snapshots remain immutable.
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
