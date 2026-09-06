import type { CaseActivity, CaseExecutionHistoryPage } from "@autoforge/application";
import type { FailureAnalysisHistoryPageView } from "@autoforge/contracts";
import type { CaseDefinitionWithMethods, CaseVersion } from "@autoforge/domain";

export type CaseDetailView = {
  definition: CaseDefinitionWithMethods;
  versions: CaseVersion[];
  activity: CaseActivity;
  executionHistory: CaseExecutionHistoryPage;
  failureAnalysisHistory: FailureAnalysisHistoryPageView;
  projectVersionName: string;
  testStageName: string;
  executable: boolean;
  canManage: boolean;
  canRun: boolean;
  canReadLogs: boolean;
  canReadSource: boolean;
  canReadAnalysisEvidence: boolean;
  timeZone: string;
};
