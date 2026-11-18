import { AI_RECOMMENDATION_LABELS } from "@autoforge/contracts";

export const AI_ANALYSIS_RESULT_LABEL = "AI 初步分析结果";
export const AI_ANALYSIS_REASON_LABEL = "AI 初步分析原因";

const LEGACY_DETAIL = /^(?:可能原因|建议检查|证据限制|模型自评置信度)[：:]/u;
const REASON_PREFIX = /^原因[：:]\s*/u;

/** Read the formats written by both AI workers, preserving unstructured historical text. */
export function splitAiAnalysisConclusion(conclusion: string | null | undefined) {
  const text = conclusion?.trim().replace(/\r\n?/gu, "\n") ?? "";
  const lines = text.split("\n");
  if (lines[0]?.startsWith("AI 初步建议（")) {
    const firstDetail = lines.findIndex((line, index) => index > 1 && LEGACY_DETAIL.test(line));
    return firstDetail > 0
      ? {
          result: lines.slice(0, firstDetail).join("\n").trim(),
          reason: lines.slice(firstDetail).join("\n").trim(),
        }
      : { result: text, reason: "" };
  }

  if (lines[1] && REASON_PREFIX.test(lines[1])) {
    return {
      result: lines[0]!,
      reason: [lines[1].replace(REASON_PREFIX, ""), ...lines.slice(2)].join("\n").trim(),
    };
  }

  const recommendation = Object.values(AI_RECOMMENDATION_LABELS).find(
    (label) => text.startsWith(`${label}：`) || text.startsWith(`${label}:`),
  );
  return recommendation
    ? { result: recommendation, reason: text.slice(recommendation.length + 1).trim() }
    : { result: text, reason: "" };
}
