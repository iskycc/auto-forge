import type { FailureAnalysisClaimView } from "@autoforge/contracts";
import type { FailureAnalysisCategory } from "@autoforge/domain";

export type FailureAnalysisCopyDraft = {
  category?: FailureAnalysisCategory;
  issueDescription?: string;
  caseFixEvidence?: string;
  ticketReference?: string;
  remark?: string;
};

export function formatFailureAnalysisClipboard(
  claims: readonly FailureAnalysisClaimView[],
  draft: FailureAnalysisCopyDraft,
): { text: string; html: string } {
  const conclusion = conclusionFields(draft);
  const textSections = claims.map((claim, index) =>
    [
      `${index + 1}. ${claim.caseName}`,
      `类路径：${claim.className}`,
      `用例 ID：${claim.caseDefinitionId}`,
      `执行记录：${claim.executionRunId}`,
      `执行尝试：${claim.attemptId}（第 ${claim.attemptNumber} 次）`,
      `执行结果：${claim.resultCode ?? "失败"}`,
      `失败概要：${claim.failureSummary || "—"}`,
      ...conclusion.map(([label, value]) => `${label}：${value}`),
    ].join("\n"),
  );
  const text = [
    `AutoForge 用例分析（${claims.length} 个）`,
    "",
    ...joinWithBlankLine(textSections),
  ].join("\n");
  const html = [
    `<section><h2>AutoForge 用例分析（${claims.length} 个）</h2>`,
    "<ol>",
    ...claims.map(
      (claim) =>
        `<li><h3>${escapeHtml(claim.caseName)}</h3><dl>${caseFields(claim, conclusion)
          .map(
            ([label, value]) =>
              `<dt><strong>${escapeHtml(label)}</strong></dt><dd>${escapeHtml(value)}</dd>`,
          )
          .join("")}</dl></li>`,
    ),
    "</ol></section>",
  ].join("");
  return { text, html };
}

function caseFields(
  claim: FailureAnalysisClaimView,
  conclusion: Array<[string, string]>,
): Array<[string, string]> {
  return [
    ["类路径", claim.className],
    ["用例 ID", claim.caseDefinitionId],
    ["执行记录", claim.executionRunId],
    ["执行尝试", `${claim.attemptId}（第 ${claim.attemptNumber} 次）`],
    ["执行结果", claim.resultCode ?? "失败"],
    ["失败概要", claim.failureSummary || "—"],
    ...conclusion,
  ];
}

function conclusionFields(draft: FailureAnalysisCopyDraft): Array<[string, string]> {
  return [
    draft.category ? (["分析结论", categoryLabel(draft.category)] as const) : undefined,
    normalizedField("问题说明", draft.issueDescription),
    normalizedField("用例修改证明", draft.caseFixEvidence),
    normalizedField("问题单", draft.ticketReference),
    normalizedField("备注", draft.remark),
  ].filter((field): field is [string, string] => Boolean(field));
}

function normalizedField(label: string, value: string | undefined): [string, string] | undefined {
  const normalized = value?.trim();
  return normalized ? [label, normalized] : undefined;
}

function categoryLabel(category: FailureAnalysisCategory): string {
  return {
    rerun_passed: "重跑通过",
    case_fixed: "用例问题已修改",
    code_issue_filed: "代码问题已提单",
  }[category];
}

function joinWithBlankLine(sections: readonly string[]): string[] {
  return sections.flatMap((section, index) => (index === 0 ? [section] : ["", section]));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!;
  });
}
