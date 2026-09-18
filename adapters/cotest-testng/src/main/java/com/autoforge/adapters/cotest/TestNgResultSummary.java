package com.autoforge.adapters.cotest;

/** 监听器统计的执行结果概要；失败、跳过与配置失败均代表本次执行不通过。 */
final class TestNgResultSummary {
  private final int passedCount;
  private final int failedCount;
  private final int skippedCount;
  private final int configurationFailureCount;

  TestNgResultSummary(
      int passedCount,
      int failedCount,
      int skippedCount,
      int configurationFailureCount) {
    this.passedCount = passedCount;
    this.failedCount = failedCount;
    this.skippedCount = skippedCount;
    this.configurationFailureCount = configurationFailureCount;
  }

  int passedCount() {
    return passedCount;
  }

  int failedCount() {
    return failedCount;
  }

  int skippedCount() {
    return skippedCount;
  }

  int configurationFailureCount() {
    return configurationFailureCount;
  }
}
