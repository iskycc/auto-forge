package com.autoforge.javacases;

import com.huawei.cotest.util.ProjectFileUtil;
import org.testng.Assert;
import org.testng.annotations.Test;

/**
 * java-cases 后续补槽用例：Runner 并发度为 2 时，本用例只能在 Alpha/Beta
 * 任一完成后启动，用于验证跨调度波次仍复用同一个批次运行时。
 */
public final class JavaCasesConcurrentGammaFixture {
  static final String EXPECTED_ENVIRONMENT_VALUE = "java-cases-env-v2";

  @Test(groups = {"java-cases", "concurrency"}, description = "java-cases 后续补槽 Gamma")
  public void executesAfterInitialConcurrentWave() throws Exception {
    String environmentValue = System.getenv("AUTOFORGE_JAVA_CASES_ENV");
    Assert.assertEquals(
        environmentValue,
        EXPECTED_ENVIRONMENT_VALUE,
        "The managed environment variable version was not injected.");
    Assert.assertEquals(
        ProjectFileUtil.getEnvIP(),
        JavaCasesConstants.ENVIRONMENT_ADDRESS,
        "The task-scoped Adapter environment address was not injected.");

    System.out.println("JAVA_CASES_CONCURRENT_GAMMA_START");
    // 保留文件系统观察窗口，供 E2E 核对后续 attempt 的共享符号链接与 inode。
    Thread.sleep(6_000);
    System.err.println("JAVA_CASES_CONCURRENT_GAMMA_STDERR");
    System.out.println("JAVA_CASES_CONCURRENT_GAMMA_DONE");
  }
}
