/** Preserve historical foreign keys while making every former credential unusable. */
export function runnerPurgeValues(input: { runnerId: string; purgedAt: string }) {
  return {
    purgedAt: input.purgedAt,
    credentialHash: `purged:${input.runnerId}`,
    previousCredentialHash: null,
    previousCredentialValidUntil: null,
    credentialRotationRequestedAt: null,
    labelsJson: "[]",
    capabilitiesJson: "[]",
    updatedAt: input.purgedAt,
  };
}
