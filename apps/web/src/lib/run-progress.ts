import {
  classifyAttemptResult,
  executionRunsForRound,
  type RunAttempt,
  type RunBatchDetails,
} from "@autoforge/domain";
import type { RunBatchDetailOverview } from "@autoforge/application";

import { isActiveRunBatch, runBatchCompletionLabel } from "./run-batch-presentation";

export type RunProgress = {
  batchId: string;
  suiteName: string;
  status: RunBatchDetails["status"];
  statusLabel: string;
  active: boolean;
  currentRound: number;
  maximumRounds: number;
  totalCases: number;
  completedCases: number;
  totalPassed: number;
  finalFailed: number;
  currentRoundTotal: number;
  currentRoundPassed: number;
  currentRoundFailed: number;
  currentRoundCompleted: number;
  updatedAt: string;
};

export function buildRunProgress(batch: RunBatchDetails): RunProgress {
  const currentRound = effectiveCurrentRound(batch);
  const currentAttempts = attemptsForRound(batch, currentRound);
  const currentRoundPassed = currentAttempts.filter(
    (attempt) => attempt.outcome === "succeeded",
  ).length;
  const currentRoundFailed = currentAttempts.filter(
    (attempt) =>
      attempt.outcome !== undefined &&
      attempt.outcome !== "succeeded" &&
      classifyAttemptResult({
        outcome: attempt.outcome,
        ...(attempt.resultCode ? { resultCode: attempt.resultCode } : {}),
      }) !== "succeeded",
  ).length;
  return {
    batchId: batch.id,
    suiteName: batch.suiteName,
    status: batch.status,
    statusLabel: runBatchCompletionLabel(batch),
    active: isActiveRunBatch(batch.status),
    currentRound,
    maximumRounds: batch.retryLimit + 1,
    totalCases: batch.totalRuns,
    completedCases:
      batch.succeededRuns + batch.failedRuns + batch.timedOutRuns + batch.cancelledRuns,
    totalPassed: batch.succeededRuns,
    finalFailed: batch.failedRuns + batch.timedOutRuns,
    currentRoundTotal: executionRunsForRound(batch.runs, batch.attempts, currentRound).length,
    currentRoundPassed,
    currentRoundFailed,
    currentRoundCompleted: currentAttempts.filter((attempt) => attempt.finishedAt).length,
    updatedAt: batch.updatedAt,
  };
}

export function buildRunProgressFromOverview(overview: RunBatchDetailOverview): RunProgress {
  const batch = overview.batch;
  const currentRound =
    batch.retryMode === "round"
      ? batch.currentRound
      : Math.max(1, ...overview.roundSummaries.map((summary) => summary.round));
  const current = overview.roundSummaries.find((summary) => summary.round === currentRound);
  const currentRoundFailed = current ? current.failed + current.timedOut + current.cancelled : 0;
  return {
    batchId: batch.id,
    suiteName: batch.suiteName,
    status: batch.status,
    statusLabel: runBatchCompletionLabel(batch),
    active: isActiveRunBatch(batch.status),
    currentRound,
    maximumRounds: batch.retryLimit + 1,
    totalCases: batch.totalRuns,
    completedCases:
      batch.succeededRuns + batch.failedRuns + batch.timedOutRuns + batch.cancelledRuns,
    totalPassed: batch.succeededRuns,
    finalFailed: batch.failedRuns + batch.timedOutRuns,
    currentRoundTotal: current?.totalRuns ?? 0,
    currentRoundPassed: current?.passed ?? 0,
    currentRoundFailed,
    currentRoundCompleted: current
      ? current.passed + current.failed + current.timedOut + current.cancelled
      : 0,
    updatedAt: batch.updatedAt,
  };
}

function effectiveCurrentRound(batch: RunBatchDetails): number {
  if (batch.retryMode === "round") return batch.currentRound;
  return Math.max(1, ...batch.attempts.map((attempt) => attempt.attemptNumber));
}

function attemptsForRound(batch: RunBatchDetails, round: number): RunAttempt[] {
  return batch.attempts.filter((attempt) => attempt.attemptNumber === round);
}
