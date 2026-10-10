/** ExecutionId identifies a RunAttempt, including its precise round or diagnostic rerun. */
export function publicCaseLogPath(executionId: string, selectedAttemptId?: string): string {
  const parameters = new URLSearchParams({ ExecutionId: executionId });
  if (selectedAttemptId) parameters.set("AttemptId", selectedAttemptId);
  return `/CaseLog?${parameters}`;
}

export function publicExecutionPath(batchId: string): string {
  return `/Execution?${new URLSearchParams({ BatchId: batchId })}`;
}
