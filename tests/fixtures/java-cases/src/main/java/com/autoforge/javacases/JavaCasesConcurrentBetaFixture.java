package com.autoforge.javacases;

import com.huawei.cotest.util.ProjectFileUtil;
import org.testng.Assert;
import org.testng.annotations.Test;

/**
 * java-cases 并发 Beta 用例：与 Alpha 用例同时调度，用于验证多 attempt
 * 并发执行时日志不会相互窜入。
 */
public final class JavaCasesConcurrentBetaFixture {
  @Test(groups = {"java-cases", "concurrency"}, description = "java-cases 并发 Beta")
  public void executesConcurrentBeta() throws Exception {
    Assert.assertEquals(
        ProjectFileUtil.getEnvIP(),
        JavaCasesConstants.ENVIRONMENT_ADDRESS,
        "The task-scoped Adapter environment address was not injected.");

    System.out.println("JAVA_CASES_CONCURRENT_BETA_START");
    // 保持运行一段时间，确保与 Alpha attempt 的执行窗口有重叠。
    Thread.sleep(6_000);
    System.err.println("JAVA_CASES_CONCURRENT_BETA_STDERR");
    System.out.println("JAVA_CASES_CONCURRENT_BETA_DONE");
  }
}
