export function roundRecoverySecretPurpose(suiteId: string, ruleId: string): string {
  return `case-suite-round-recovery:${suiteId}:${ruleId}`;
}
