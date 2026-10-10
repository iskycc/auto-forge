export const MANUAL_STOP_WARNING_STORAGE_KEY = "autoforge.manual-execution.stop-warning.v1";

export function skipManualStopWarning(storage: Pick<Storage, "getItem">): boolean {
  try {
    return storage.getItem(MANUAL_STOP_WARNING_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Storage failures leave the warning enabled and are reported by the control. */
export function rememberManualStopWarning(storage: Pick<Storage, "setItem">): boolean {
  try {
    storage.setItem(MANUAL_STOP_WARNING_STORAGE_KEY, "true");
    return true;
  } catch {
    return false;
  }
}
