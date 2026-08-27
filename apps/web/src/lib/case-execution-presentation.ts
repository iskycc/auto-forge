export function caseExecutionStatusLabel(status: string): string {
  return (
    {
      queued: "等待资源",
      assigned: "已分配",
      running: "执行中",
      succeeded: "成功",
      failed: "失败",
      timed_out: "超时",
      cancelled: "已取消",
    }[status] ?? "未知状态"
  );
}

export function caseExecutionResultLabel(code: string | undefined): string {
  if (!code) return "—";
  return (
    {
      succeeded: "成功",
      failed: "失败",
      skipped: "跳过",
      timed_out: "超时",
      cancelled: "已取消",
      TESTNG_SUCCEEDED: "TestNG 通过",
      TESTNG_SUCCEEDED_WITH_SKIPS: "TestNG 通过（含跳过）",
      TESTNG_ASSERTIONS_FAILED: "TestNG 断言失败",
      TESTNG_CONFIGURATION_FAILED: "TestNG 配置失败",
      TESTNG_EXIT_NONZERO: "TestNG 异常退出",
      TESTNG_FAILURE: "TestNG 执行失败",
      TESTNG_NO_TESTS: "未发现 TestNG 测试",
      ADAPTER_CASE_TIMEOUT: "Adapter 用例超时",
      EXECUTION_TIMEOUT: "执行超时",
      EXECUTION_CANCELLED: "执行已取消",
      CANCELLED_BY_CONTROL_PLANE: "由控制面取消",
      ASSIGNMENT_CLAIM_TIMEOUT: "执行机领取超时",
      LEASE_EXPIRED: "执行租约已过期",
      PROCESS_START_FAILED: "进程启动失败",
      RESOURCE_MEMORY_EXCEEDED: "超出内存限制",
      AGENT_RESTARTED_DURING_EXECUTION: "执行期间 Agent 重启",
      BATCH_TERMINATED_BEFORE_EXECUTION: "执行前批次已终止",
      OK: "成功",
      PASSED: "通过",
      TEST_ASSERTION_FAILED: "测试断言失败",
    }[code] ?? "其他结果"
  );
}
