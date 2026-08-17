package com.autoforge.adapters.cotest;

/** 监听器统计的执行结果概要；是否失败以失败数与配置失败数为准，跳过不计入失败。 */
final class TestNgResultSummary {
  private final int passedCount;
  private final int failedCount;
  private final int skippedCount;
  private final int configurationFailureCount;
  private final String firstFailure;

  TestNgResultSummary(
      int passedCount,
      int failedCount,
      int skippedCount,
      int configurationFailureCount,
      String firstFailure) {
    this.passedCount = passedCount;
    this.failedCount = failedCount;
    this.skippedCount = skippedCount;
    this.configurationFailureCount = configurationFailureCount;
    this.firstFailure = firstFailure;
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

  String firstFailure() {
    return firstFailure;
  }
}
