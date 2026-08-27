import type { SchedulingEventDraft } from "@autoforge/application";

/**
 * 调度事件批量写入。unnest 数组参数替代逐行占位符：数百事件时绑定参数开销
 * 下降一个数量级；单条语句天然原子，一轮事件要么整体可见、要么整体失败。
 * 调度派发路径（PostgresRunBatchRepository）使用本实现；完成上报事务因在
 * 单条多 CTE 语句内落库，以同形 CTE 内联此语句（postgres-execution-control.ts
 * 的 ins_sched），两处修改时必须保持列与参数顺序一致。
 */
const SCHEDULING_EVENT_INSERT_SQL = `INSERT INTO scheduling_events
   (id, batch_id, runner_id, execution_run_id, attempt_id, event_type, message,
    payload_json, recorded_at)
 SELECT s.id, s.batch_id, s.runner_id, s.execution_run_id, s.attempt_id, s.event_type,
        s.message, s.payload_json, s.recorded_at
 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
             $7::text[], $8::text[], $9::text[])
   AS s(id, batch_id, runner_id, execution_run_id, attempt_id, event_type, message,
        payload_json, recorded_at)`;

export interface SchedulingEventInsertExecutor {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export async function insertSchedulingEventDrafts(
  executor: SchedulingEventInsertExecutor,
  events: readonly SchedulingEventDraft[],
): Promise<void> {
  if (events.length === 0) return;
  await executor.query(SCHEDULING_EVENT_INSERT_SQL, [
    events.map((event) => event.id),
    events.map((event) => event.batchId),
    events.map((event) => event.runnerId ?? null),
    events.map((event) => event.executionRunId ?? null),
    events.map((event) => event.attemptId ?? null),
    events.map((event) => event.eventType),
    events.map((event) => event.message),
    events.map((event) => (event.payload ? JSON.stringify(event.payload) : null)),
    events.map((event) => event.recordedAt),
  ]);
}
