export type FailureAnalysisBatchLifecycle = {
  startedAt: string | null;
  progressStartedAt: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
};

export function analysisLifecycleView(lifecycle: FailureAnalysisBatchLifecycle) {
  return {
    ...(lifecycle.startedAt ? { startedAt: lifecycle.startedAt } : {}),
    ...(lifecycle.progressStartedAt ? { progressStartedAt: lifecycle.progressStartedAt } : {}),
    ...(lifecycle.archivedAt ? { archivedAt: lifecycle.archivedAt } : {}),
    ...(lifecycle.archivedBy ? { archivedBy: lifecycle.archivedBy } : {}),
  };
}

export const analysisLifecycleColumns = `
  analysis.started_at AS "startedAt",
  analysis.progress_started_at AS "progressStartedAt",
  analysis.archived_at AS "archivedAt", analysis.archived_by AS "archivedBy"`;

export function analysisBatchVisibilitySql(
  view: "started" | "available" | "archived" = "started",
): string {
  if (view === "available") return "analysis.batch_id IS NULL";
  return `analysis.batch_id IS NOT NULL AND analysis.archived_at IS ${view === "archived" ? "NOT " : ""}NULL`;
}
