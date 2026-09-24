import type { DdtCaseSummary } from "@autoforge/domain";
import type { CaseDetailView, CaseHistoryView } from "./case-detail-view";

export type DdtCaseDetailView = {
  item: DdtCaseSummary;
} & (
  | { executionDetail: CaseDetailView; historyDetail?: never }
  | { executionDetail?: never; historyDetail: CaseHistoryView }
);
