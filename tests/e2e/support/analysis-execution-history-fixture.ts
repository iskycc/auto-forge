import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createAttemptLogStore } from "../../../packages/db/src/attempt-log-store";

export async function insertAnalysisExecutionHistory(
  dataDirectory: string,
  batchId: string,
  suffix: string,
) {
  const database = new DatabaseSync(resolve(dataDirectory, "db", "autoforge.sqlite"));
  const logs = createAttemptLogStore(resolve(dataDirectory, "attempt-logs"));
  const previousAttemptIds: string[] = [];
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const anchor = database
      .prepare("SELECT created_at FROM run_batches WHERE id=?")
      .get(batchId) as { created_at: string };
    for (let index = 0; index < 6; index += 1) {
      const historyBatchId = randomUUID();
      const recordedAt = new Date(
        Date.parse(anchor.created_at) - (index + 1) * 86_400_000,
      ).toISOString();
      database
        .prepare(
          `INSERT INTO run_batches
        (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,environment_json,
         total_runs,project_id,policy_json,created_at,updated_at)
        VALUES (?,?,?,'历史执行',1,'succeeded',0,'[]',2,?,'{}',?,?)`,
        )
        .run(
          historyBatchId,
          980 - index,
          `suite-${suffix}`,
          DEFAULT_PROJECT_ID,
          recordedAt,
          recordedAt,
        );
      for (const caseIndex of [0, 1]) {
        const runId = randomUUID();
        const attemptId = randomUUID();
        const outcome = (index + caseIndex) % 2 === 0 ? "succeeded" : "failed";
        database
          .prepare(
            `INSERT INTO execution_runs
          (id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,terminal_outcome,created_at,updated_at)
          VALUES (?,?,?,1,'历史用例',?,?,1,?,?,?)`,
          )
          .run(
            runId,
            historyBatchId,
            `case-run-failed-${caseIndex}-${suffix}`,
            `e2e.analysis.Failed${caseIndex}Test`,
            outcome,
            outcome,
            recordedAt,
            recordedAt,
          );
        database
          .prepare(
            `INSERT INTO run_attempts
          (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,result_summary,created_at,finished_at)
          VALUES (?,?,?,1,?,1,?,?,?,?)`,
          )
          .run(
            attemptId,
            runId,
            `analysis-runner-${suffix}`,
            outcome,
            outcome,
            outcome === "succeeded" ? "所有断言通过" : "断言失败：响应状态不一致",
            recordedAt,
            recordedAt,
          );
        if (index === 0) previousAttemptIds.push(attemptId);
        await logs.appendChunks({
          batchId: historyBatchId,
          attemptId,
          receivedAt: recordedAt,
          chunks: [
            {
              stream: "stdout",
              sequence: 0,
              content: comparisonText(caseIndex, false),
              recordedAt,
            },
            {
              stream: "agent",
              sequence: 0,
              content: Array.from({ length: 2100 }, (_, line) => `历史诊断 ${line}\n`).join(""),
              recordedAt,
            },
          ],
        });
      }
    }
    for (const caseIndex of [0, 1]) {
      await logs.appendChunks({
        batchId,
        attemptId: `attempt-run-failed-${caseIndex}-${suffix}`,
        receivedAt: anchor.created_at,
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: comparisonText(caseIndex, true),
            recordedAt: anchor.created_at,
          },
          {
            stream: "agent",
            sequence: 0,
            content: Array.from({ length: 2100 }, (_, line) => `本次诊断 ${line}\n`).join(""),
            recordedAt: anchor.created_at,
          },
        ],
      });
    }
    return { previousAttemptIds };
  } finally {
    logs.close();
    database.close();
  }
}

function comparisonText(caseIndex: number, current: boolean) {
  return Array.from({ length: 420 }, (_, index) => {
    if (index === 8) return `用例 ${caseIndex} 响应状态：${current ? "500" : "200"}`;
    if (index === 260)
      return current ? "断言失败：实际值与期望值不一致" : "断言通过：实际值与期望值一致";
    return `步骤 ${String(index).padStart(3, "0")} · 读取订单数据并校验响应字段`;
  }).join("\n");
}
