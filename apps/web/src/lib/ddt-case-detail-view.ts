import type { DdtCaseSummary } from "@autoforge/domain";
import type { CaseDetailView } from "./case-detail-view";

export type DdtCaseDetailView = {
  item: DdtCaseSummary;
  executionDetail: CaseDetailView;
};
