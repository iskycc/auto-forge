import {
  failureAnalysisCompletionOrderSchema,
  failureAnalysisSortSchema,
  type FailureAnalysisCompletionOrder,
  type FailureAnalysisSort,
} from "@autoforge/contracts";
import { z } from "zod";

export const FAILURE_ANALYSIS_PREFERENCES_STORAGE_KEY = "autoforge.failure-analysis.preferences.v1";

export type FailureAnalysisPreferences = {
  candidateSort: FailureAnalysisSort;
  candidateDirection: "asc" | "desc";
  analysisSort: FailureAnalysisSort;
  analysisDirection: "asc" | "desc";
  completionOrder: FailureAnalysisCompletionOrder;
  includeCompleted: boolean;
};

const directionSchema = z.enum(["asc", "desc"]);
const failureAnalysisPreferencesSchema = z.object({
  candidateSort: failureAnalysisSortSchema,
  candidateDirection: directionSchema,
  analysisSort: failureAnalysisSortSchema,
  analysisDirection: directionSchema,
  completionOrder: failureAnalysisCompletionOrderSchema,
  includeCompleted: z.boolean(),
});

const PREFERENCE_QUERY_PARAMETERS: Record<keyof FailureAnalysisPreferences, string> = {
  candidateSort: "candidateSort",
  candidateDirection: "candidateDirection",
  analysisSort: "analysisSort",
  analysisDirection: "analysisDirection",
  completionOrder: "completionOrder",
  includeCompleted: "includeCompleted",
};

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function readFailureAnalysisPreferences(
  storage: Pick<PreferenceStorage, "getItem">,
): FailureAnalysisPreferences | undefined {
  try {
    const raw = storage.getItem(FAILURE_ANALYSIS_PREFERENCES_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = failureAnalysisPreferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function resolveFailureAnalysisPreferences(
  initial: FailureAnalysisPreferences,
  remembered: FailureAnalysisPreferences | undefined,
  search: string,
): FailureAnalysisPreferences {
  if (!remembered) return initial;
  const parameters = new URLSearchParams(search);
  return Object.fromEntries(
    Object.entries(PREFERENCE_QUERY_PARAMETERS).map(([key, parameter]) => [
      key,
      parameters.has(parameter)
        ? initial[key as keyof FailureAnalysisPreferences]
        : remembered[key as keyof FailureAnalysisPreferences],
    ]),
  ) as FailureAnalysisPreferences;
}

export function writeFailureAnalysisPreferences(
  storage: Pick<PreferenceStorage, "setItem">,
  preferences: FailureAnalysisPreferences,
): void {
  try {
    storage.setItem(
      FAILURE_ANALYSIS_PREFERENCES_STORAGE_KEY,
      JSON.stringify(failureAnalysisPreferencesSchema.parse(preferences)),
    );
  } catch {
    // 隐私模式或被禁用的浏览器存储不应阻断认领和分析流程。
  }
}
