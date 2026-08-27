-- 调度事件是只追加的诊断流水：事件总在引用对象创建/校验之后写入，引用完整性
-- 由应用写入路径保证，不再由外键强制。外键检查让每条事件 INSERT 对
-- run_batches 等父表行持有 FOR KEY SHARE，与完成上报事务的 FOR UPDATE 在锁队列
-- 中互相排队（高并发基准中累计等待远超事件写入本身），拖慢调度、领取与完成
-- 链路。批次删除时的事件清理由保留周期显式执行（见 platform-operations 仓储）。
ALTER TABLE scheduling_events DROP CONSTRAINT scheduling_events_batch_id_fkey;
ALTER TABLE scheduling_events DROP CONSTRAINT scheduling_events_runner_id_fkey;
ALTER TABLE scheduling_events DROP CONSTRAINT scheduling_events_execution_run_id_fkey;
ALTER TABLE scheduling_events DROP CONSTRAINT scheduling_events_attempt_id_fkey;
