import { normalizeDdtCaseData, omitEmptyDdtFields, type DdtCaseData } from "@autoforge/domain";

/** Keep only actual cell values; merged sheet headers never add parameters to a case. */
export function normalizeImportedDdtCaseData(row: DdtCaseData): DdtCaseData {
  return normalizeDdtCaseData(omitEmptyDdtFields(row));
}
