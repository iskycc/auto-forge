import type { FailureAnalysisClaimView, FailureAnalysisSheetRow } from "@autoforge/contracts";

export type AnalysisSheetDraft = {
  category: FailureAnalysisClaimView["category"] | "";
  issueDescription: string;
  caseFixEvidence: string;
  ticketReference: string;
  remark: string;
};
export type AnalysisSheetField = keyof AnalysisSheetDraft;

export const analysisSheetColumns: readonly {
  field: AnalysisSheetField;
  label: string;
  width: number;
}[] = [
  { field: "category", label: "分析类别", width: 160 },
  { field: "issueDescription", label: "问题说明", width: 240 },
  { field: "ticketReference", label: "问题单", width: 190 },
  { field: "caseFixEvidence", label: "修改证明", width: 220 },
  { field: "remark", label: "分析备注", width: 240 },
];

export const analysisCategoryLabels = {
  rerun_passed: "重跑通过",
  case_fixed: "用例问题已修改",
  code_issue_filed: "代码问题已提单",
} as const;

export function analysisSheetDraft(row: FailureAnalysisSheetRow): AnalysisSheetDraft {
  const claim = row.analysis;
  return {
    category: claim?.category ?? "",
    issueDescription: claim?.issueDescription ?? "",
    caseFixEvidence: claim?.caseFixEvidence ?? "",
    ticketReference: claim?.ticketReference ?? "",
    remark: claim?.remark ?? "",
  };
}

/** Fill only this page's editable cells; identity, result and evidence never enter the draft model. */
export function fillAnalysisColumn(input: {
  rowIds: readonly string[];
  drafts: Readonly<Record<string, AnalysisSheetDraft>>;
  sourceIndex: number;
  targetIndex: number;
  field: AnalysisSheetField;
  editable: ReadonlySet<string>;
}): {
  drafts: Readonly<Record<string, AnalysisSheetDraft>>;
  updatedIds: string[];
  skippedCount: number;
} {
  const { rowIds, drafts, sourceIndex, targetIndex, field, editable } = input;
  const sourceId = rowIds[sourceIndex];
  const source = sourceId ? drafts[sourceId] : undefined;
  if (
    !sourceId ||
    !source ||
    !editable.has(sourceId) ||
    !Number.isInteger(sourceIndex) ||
    !Number.isInteger(targetIndex) ||
    sourceIndex < 0 ||
    targetIndex <= sourceIndex ||
    targetIndex >= rowIds.length
  ) {
    return { drafts, updatedIds: [], skippedCount: 0 };
  }
  const next = { ...drafts };
  const updatedIds: string[] = [];
  let skippedCount = 0;
  for (let index = sourceIndex + 1; index <= targetIndex; index++) {
    const id = rowIds[index]!;
    const target = drafts[id];
    if (!editable.has(id) || !target) {
      skippedCount++;
      continue;
    }
    next[id] = { ...target, [field]: source[field] };
    updatedIds.push(id);
  }
  return { drafts: next, updatedIds, skippedCount };
}
