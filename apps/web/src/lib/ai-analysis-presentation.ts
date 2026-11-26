import { AI_RECOMMENDATION_LABELS } from "@autoforge/contracts";

export const AI_ANALYSIS_RESULT_LABEL = "AI 初步分析结果";
export const AI_ANALYSIS_REASON_LABEL = "AI 初步分析原因";

const LEGACY_DETAIL = /^(?:可能原因|建议检查|证据限制|模型自评置信度)[：:]/u;
const REASON_PREFIX = /^原因[：:]\s*/u;
const REVIEW_NOTE =
  /[（(]\s*(?:(?:分析中|已分析)\s+\d+\/\d+\s+证据片[；;]\s*|分析中[，,]\s*)?(?:待(?:人工)?确认|需(?:要)?人工确认)\s*[）)]/gu;
const REVIEW_LINE =
  /^(?:AI 初步建议(?:[（(](?:分析中|已分析) \d+\/\d+(?: 证据片)?[）)])?|(?:分析中[，,]\s*)?(?:待(?:人工)?确认|需(?:要)?人工确认))[。.]?$/u;
const REVIEW_CLAUSE = /[，,；;]\s*(?:待人工确认|需(?:要)?人工确认)\s*(?=[。.]?$)/u;

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

export function aiExportText(text: string): string {
  return text
    .replace(REVIEW_NOTE, "")
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^可能原因(?=[：:])/u, "原因")
        .replace(REVIEW_CLAUSE, ""),
    )
    .filter((line) => !REVIEW_LINE.test(line))
    .join("\n")
    .trim();
}

export function aiExportResult(value: string): string {
  return Object.values(AI_RECOMMENDATION_LABELS).reduce(
    (text, label) => text.replaceAll(label, label.replace(/^可能/u, "")),
    aiExportText(value),
  );
}
