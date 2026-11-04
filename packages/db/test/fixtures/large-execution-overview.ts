type LargeExecutionFixture = {
  dialect: "sqlite" | "postgres";
  batchId: string;
  runnerId: string;
  suiteId: string;
  projectId: string;
  projectVersionId?: string;
  caseCount: number;
  roundCount: number;
  recordedAt: string;
};

/** Bulk inserts synthetic execution facts without involving real Runner processes or logs. */
export async function seedLargeExecutionOverview(
  execute: (statement: string) => Promise<unknown>,
  input: LargeExecutionFixture,
): Promise<void> {
  const { dialect, caseCount, roundCount } = input;
  const batch = quoted(input.batchId);
  const runner = quoted(input.runnerId);
  const recordedAt = quoted(input.recordedAt);
  const policy = quoted(
    JSON.stringify(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
  );
  await execute(`
    INSERT INTO runners(id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at)
    VALUES(${runner},${runner},'Overview runner','linux','amd64','1.0.0',1,'[]','[]',1,0,${recordedAt},${recordedAt},${recordedAt});
    INSERT INTO run_batches(id,project_id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,version,current_round,policy_json,created_at,updated_at,scheduled_for)
    VALUES(${batch},${quoted(input.projectId)},${quoted(input.suiteId)},'Large completed execution',1,'succeeded',${roundCount - 1},'[]',${caseCount},1,${roundCount},${policy},${recordedAt},${recordedAt},${recordedAt});
    ${dialect === "sqlite" ? `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<${caseCount})` : `WITH numbers(n) AS (SELECT generate_series(1,${caseCount}))`}
    INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,terminal_outcome,execution_round,attempt_count,created_at,updated_at)
    SELECT ${batch}||'-run-'||n,${batch},${batch}||'-case-'||n,1,'Case '||n,'load.Test'||n,'succeeded','succeeded',${roundCount},${roundCount},${recordedAt},${recordedAt} FROM numbers;
    INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,execution_round,status,outcome,scheduling_score,created_at,started_at,finished_at,duration_ms)
    SELECT run.id||'-'||round.n,run.id,${runner},round.n,round.n,
      CASE WHEN round.n=${roundCount} THEN 'succeeded' ELSE 'failed' END,
      CASE WHEN round.n=${roundCount} THEN 'succeeded' ELSE 'failed' END,
      1,${recordedAt},${recordedAt},${recordedAt},0
    FROM execution_runs run CROSS JOIN (${Array.from({ length: roundCount }, (_, index) => `SELECT ${index + 1} AS n`).join(" UNION ALL ")}) round
    WHERE run.batch_id=${batch};
    INSERT INTO run_batch_runners(batch_id,runner_id) VALUES(${batch},${runner});
  `);
  await execute("ANALYZE");
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
