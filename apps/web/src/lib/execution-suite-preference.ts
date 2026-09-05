type PreferenceScope = {
  userId: string;
  projectId: string;
  projectVersionId: string;
};

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function executionSuitePreferenceKey(scope: PreferenceScope): string {
  return `autoforge.execution-suite.v1:${JSON.stringify([scope.userId, scope.projectId, scope.projectVersionId])}`;
}

export function readExecutionSuitePreference(
  storage: () => Pick<PreferenceStorage, "getItem">,
  key: string,
): string | undefined {
  try {
    const value = storage().getItem(key);
    return value && value.length <= 128 ? value : undefined;
  } catch {
    // Storage can be disabled by browser policy; the dialog keeps a session fallback.
    return undefined;
  }
}

export function writeExecutionSuitePreference(
  storage: () => Pick<PreferenceStorage, "setItem">,
  key: string,
  suiteId: string,
): boolean {
  try {
    storage().setItem(key, suiteId);
    return true;
  } catch {
    // Remembering a convenience preference must not prevent task selection or execution.
    return false;
  }
}

export function preferredExecutionSuiteId(
  availableSuites: readonly { id: string }[],
  rememberedId: string | undefined,
): string {
  if (rememberedId !== undefined) {
    return availableSuites.some((suite) => suite.id === rememberedId) ? rememberedId : "";
  }
  return availableSuites[0]?.id ?? "";
}
