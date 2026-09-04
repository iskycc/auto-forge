import { describe, expect, it } from "vitest";

import {
  FAILURE_ANALYSIS_PREFERENCES_STORAGE_KEY,
  readFailureAnalysisPreferences,
  resolveFailureAnalysisPreferences,
  writeFailureAnalysisPreferences,
  type FailureAnalysisPreferences,
} from "./failure-analysis-preferences";

const defaults: FailureAnalysisPreferences = {
  candidateSort: "class_path",
  candidateDirection: "asc",
  analysisSort: "class_path",
  analysisDirection: "asc",
  completionOrder: "pending_first",
  includeCompleted: true,
};

const remembered: FailureAnalysisPreferences = {
  candidateSort: "case_name",
  candidateDirection: "desc",
  analysisSort: "failure_summary",
  analysisDirection: "desc",
  completionOrder: "completed_first",
  includeCompleted: false,
};

describe("failure analysis preferences", () => {
  it("restores remembered controls while preserving explicit URL choices", () => {
    expect(
      resolveFailureAnalysisPreferences(
        { ...defaults, analysisSort: "claim_status" },
        remembered,
        "?analysisSort=claim_status&includeCompleted=true",
      ),
    ).toEqual({
      ...remembered,
      analysisSort: "claim_status",
      includeCompleted: true,
    });
  });

  it("ignores malformed storage and persists only the validated preference shape", () => {
    const values = new Map<string, string>([[FAILURE_ANALYSIS_PREFERENCES_STORAGE_KEY, "invalid"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(readFailureAnalysisPreferences(storage)).toBeUndefined();

    writeFailureAnalysisPreferences(storage, remembered);

    expect(readFailureAnalysisPreferences(storage)).toEqual(remembered);
  });
});
