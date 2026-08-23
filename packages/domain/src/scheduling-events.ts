// 调度事件日志：记录批次调度、run 分配、attempt 领取/完成与 runner 资源快照，
// 作为"总体日志/Runner 日志"数据源的基础模型。消息文本由应用层组装为中文。
export type SchedulingEventType =
  | "batch_scheduled" // 一轮调度周期汇总（可含未分配原因统计）
  | "run_assigned" // run 分配到 runner（每个 run 一条）
  | "attempt_claimed" // runner 领取 assignment
  | "attempt_completed" // attempt 终态（succeeded/failed/timed_out/cancelled）
  | "run_held_for_round" // 轮次重试：失败 run 被推迟到下一轮
  | "runner_fault_rescheduled" // Runner/传输异常触发的有界自动重调度
  | "round_recovery" // 整轮重跑间的 Jenkins 环境恢复状态
  | "runner_metrics"; // runner 资源快照（应用层节流写入）

export type SchedulingEvent = {
  id: string;
  batchId: string;
  runnerId?: string;
  executionRunId?: string;
  attemptId?: string;
  eventType: SchedulingEventType;
  // 人类可读中文消息，由应用层组装
  message: string;
  // 结构化补充数据，持久化时序列化为 JSON
  payload?: Record<string, unknown>;
  // ISO 8601 UTC
  recordedAt: string;
};
