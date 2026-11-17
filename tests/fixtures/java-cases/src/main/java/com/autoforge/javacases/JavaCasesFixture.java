package com.autoforge.javacases;

import com.huawei.cotest.util.ProjectFileUtil;
import org.testng.Assert;
import org.testng.annotations.Test;

/**
 * java-cases 模块的成功验收用例。断言任务保存的 Adapter 环境地址已注入，
 * 并输出可供 UI 断言的标记日志。
 */
public final class JavaCasesFixture {
  @Test(groups = {"java-cases", "smoke"}, description = "java-cases 全链路成功验收")
  public void executesThroughJavaCasesModule() throws Exception {
    System.out.println("INFO java-cases fixture started, verifying task execution configuration");
    Assert.assertEquals(
        ProjectFileUtil.getEnvIP(),
        JavaCasesConstants.ENVIRONMENT_ADDRESS,
        "The task-scoped Adapter environment address was not injected.");

    System.out.println("JAVA_CASES_STDOUT_完成:" + ProjectFileUtil.getEnvIP());
    // Keep the attempt running long enough for the UI real-time log capture
    // assertion to observe the stdout marker while the attempt is still active.
    Thread.sleep(3_000);
    System.err.println("WARN simulated slow dependency probe before final assertion");
    System.err.println("JAVA_CASES_STDERR_CAPTURED");
  }
}
