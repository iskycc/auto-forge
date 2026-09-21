import type { FailureAnalysisClaimView } from "@autoforge/contracts";
import type { FailureAnalysisCategory } from "@autoforge/domain";

export type FailureAnalysisCopyDraft = {
  category?: FailureAnalysisCategory;
  issueDescription?: string;
  caseFixEvidence?: string;
  ticketReference?: string;
  remark?: string;
};

export type FailureAnalysisClipboardCase = Pick<
  FailureAnalysisClaimView,
  "caseName" | "className" | "attemptNumber" | "resultCode" | "failureSummary"
> & { logUrl: string };

type ClipboardField = { label: string; value: string; href?: string };

export function formatFailureAnalysisClipboard(
  claims: readonly FailureAnalysisClipboardCase[],
  draft: FailureAnalysisCopyDraft,
): { text: string; html: string } {
  const conclusion = conclusionFields(draft);
  const cases = claims.map((claim) => ({
    name: claim.caseName,
    fields: caseFields(claim, conclusion),
  }));
  const textSections = cases.map(({ name, fields }, index) =>
    [`${index + 1}. ${name}`, ...fields.map(({ label, value }) => `${label}：${value}`)].join("\n"),
  );
  const text = [
    `AutoForge 用例分析（${claims.length} 个）`,
    "",
    ...joinWithBlankLine(textSections),
  ].join("\n");
  const html = [
    `<section><h2>AutoForge 用例分析（${claims.length} 个）</h2>`,
    "<ol>",
    ...cases.map(
      ({ name, fields }) =>
        `<li><h3>${escapeHtml(name)}</h3><dl>${fields.map(formatHtmlField).join("")}</dl></li>`,
    ),
    "</ol></section>",
  ].join("");
  return { text, html };
}

function caseFields(
  claim: FailureAnalysisClipboardCase,
  conclusion: Array<[string, string]>,
): ClipboardField[] {
  const logUrl = new URL(claim.logUrl);
  if (!["http:", "https:"].includes(logUrl.protocol)) throw new Error("日志链接无效，请重试。");
  return [
    { label: "类路径", value: claim.className },
    { label: "执行尝试", value: `第 ${claim.attemptNumber} 次` },
    { label: "执行结果", value: claim.resultCode ?? "失败" },
    { label: "失败概要", value: claim.failureSummary || "—" },
    { label: "日志链接", value: logUrl.href, href: logUrl.href },
    ...conclusion.map(([label, value]) => ({ label, value })),
  ];
}

function formatHtmlField({ label, value, href }: ClipboardField): string {
  const content = href
    ? `<a href="${escapeHtml(href)}">${escapeHtml(value)}</a>`
    : escapeHtml(value);
  return `<dt><strong>${escapeHtml(label)}</strong></dt><dd>${content}</dd>`;
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
