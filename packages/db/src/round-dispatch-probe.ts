import { RETRY_CONCURRENCY_RESULT_FIELDS } from "@autoforge/domain";

/** Read-only discovery, including a committed retry whose release was interrupted by exit.
 * The write transaction still applies the authoritative two-round and recovery rules.
 */
export function recoverableRoundTailSql(
  dialect: "sqlite" | "postgres",
  batch: "b" | "run_batches",
): string {
  const noActiveRuns = `NOT EXISTS(SELECT 1 FROM execution_runs active
    WHERE active.batch_id=${batch}.id AND active.status IN ('assigned','running'))`;
  const noResultDependentRules = noResultDependentRuleSql(dialect, batch);
  return `(${batch}.retry_mode='round' AND (
    EXISTS(SELECT 1 FROM execution_runs held WHERE held.batch_id=${batch}.id
      AND held.status='queued' AND held.held_round>0 AND held.held_round<=${batch}.current_round)
    OR (
      EXISTS(SELECT 1 FROM execution_runs held WHERE held.batch_id=${batch}.id
        AND held.status='queued' AND held.held_round=${batch}.current_round+1)
      AND NOT EXISTS(SELECT 1 FROM execution_runs ready WHERE ready.batch_id=${batch}.id
        AND ready.status='queued' AND ready.held_round=0)
      AND NOT EXISTS(SELECT 1 FROM execution_runs older WHERE older.batch_id=${batch}.id
        AND older.status IN ('assigned','running') AND older.execution_round<${batch}.current_round)
      AND NOT EXISTS(SELECT 1 FROM run_batch_round_recoveries barrier WHERE barrier.batch_id=${batch}.id
        AND barrier.after_round=${batch}.current_round AND barrier.status NOT IN ('idle','succeeded'))
      AND (${noActiveRuns} OR (
        NOT EXISTS(SELECT 1 FROM run_batch_round_recoveries barrier WHERE barrier.batch_id=${batch}.id
          AND barrier.after_round=${batch}.current_round)
        AND ${noResultDependentRules}
      ))
    )
  ))`;
}

export function discoverableExecutionWorkSql(
  dialect: "sqlite" | "postgres",
  batch: "b" | "run_batches",
): string {
  return `(EXISTS(SELECT 1 FROM execution_runs ready WHERE ready.batch_id=${batch}.id
    AND ready.status='queued' AND ready.held_round=0) OR ${recoverableRoundTailSql(dialect, batch)})`;
}

function noResultDependentRuleSql(
  dialect: "sqlite" | "postgres",
  batch: "b" | "run_batches",
): string {
  if (dialect === "sqlite") {
    const ruleValue = "CASE WHEN rule.type='object' THEN rule.value ELSE '{}' END";
    const fields = RETRY_CONCURRENCY_RESULT_FIELDS.map(
      (field) => `json_type(${ruleValue},'$.${field}') IS NOT NULL`,
    ).join(" OR ");
    const rules = `json_extract(${batch}.policy_json,'$.retryConcurrencyRules')`;
    return `NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_type(${batch}.policy_json,'$.retryConcurrencyRules')='array' THEN ${rules} ELSE '[]' END) rule
      WHERE COALESCE(json_extract(${ruleValue},'$.executionRound'),json_extract(${ruleValue},'$.executionRoundFrom'))=${batch}.current_round+1 AND (${fields}))`;
  }
  const rules = `${batch}.policy_json::jsonb->'retryConcurrencyRules'`;
  const fields = RETRY_CONCURRENCY_RESULT_FIELDS.map(
    (field) => `rule.value->'${field}' IS NOT NULL`,
  ).join(" OR ");
  return `NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${rules})='array' THEN ${rules} ELSE '[]'::jsonb END) rule(value)
    WHERE COALESCE(rule.value->>'executionRound',rule.value->>'executionRoundFrom')=(${batch}.current_round+1)::text AND (${fields}))`;
}
