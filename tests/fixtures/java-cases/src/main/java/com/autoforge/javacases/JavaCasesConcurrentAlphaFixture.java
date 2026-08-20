package com.autoforge.javacases;

import com.huawei.cotest.util.ProjectFileUtil;
import org.testng.Assert;
import org.testng.annotations.Test;

/**
 * java-cases 并发 Alpha 用例：与 Beta 用例同时调度，用于验证多 attempt
 * 并发执行时日志不会相互窜入。
 */
public final class JavaCasesConcurrentAlphaFixture {
  @Test(groups = {"java-cases", "concurrency"}, description = "java-cases 并发 Alpha")
  public void executesConcurrentAlpha() throws Exception {
    Assert.assertEquals(
        ProjectFileUtil.getEnvIP(),
        JavaCasesConstants.ENVIRONMENT_ADDRESS,
        "The task-scoped Adapter environment address was not injected.");

    System.out.println("JAVA_CASES_CONCURRENT_ALPHA_START");
    // 保持运行一段时间，确保与 Beta attempt 的执行窗口有重叠。
    Thread.sleep(6_000);
    System.err.println("JAVA_CASES_CONCURRENT_ALPHA_STDERR");
    System.out.println("JAVA_CASES_CONCURRENT_ALPHA_DONE");
  }
}
