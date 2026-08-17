package com.autoforge.javacases;

import com.huawei.cotest.util.ProjectFileUtil;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.testng.Assert;
import org.testng.annotations.Test;

/**
 * java-cases 模块的成功验收用例。断言受管环境变量、执行密文与任务配置的
 * Adapter 环境地址均已注入，并输出可供 UI 断言的标记日志与产物文件。
 */
public final class JavaCasesFixture {
  static final String EXPECTED_ENVIRONMENT_VALUE = "java-cases-env-v2";
  static final String EXPECTED_SECRET_VALUE = "java-cases-secret-v1-9d2f";

  @Test(groups = {"java-cases", "smoke"}, description = "java-cases 全链路成功验收")
  public void executesThroughJavaCasesModule() throws Exception {
    System.out.println("INFO java-cases fixture started, verifying injected environment");
    System.out.println("DEBUG resolving managed environment version and secret bindings");
    String environmentValue = System.getenv("AUTOFORGE_JAVA_CASES_ENV");
    String secret = System.getenv("AUTOFORGE_JAVA_CASES_SECRET");
    Assert.assertEquals(
        environmentValue,
        EXPECTED_ENVIRONMENT_VALUE,
        "The managed environment variable version was not injected.");
    Assert.assertEquals(
        secret,
        EXPECTED_SECRET_VALUE,
        "The managed secret bound to the environment version was not injected.");
    Assert.assertEquals(
        ProjectFileUtil.getEnvIP(),
        JavaCasesConstants.ENVIRONMENT_ADDRESS,
        "The task-scoped Adapter environment address was not injected.");

    // Emit the secret in two fragments so the log pipeline's redaction layer
    // must mask both halves; mirrors the real-agent fixture probe pattern.
    int split = secret.length() / 2;
    System.out.print("JAVA_CASES_SECRET_PROBE=" + secret.substring(0, split));
    System.out.flush();
    Thread.sleep(100L);
    System.out.println(secret.substring(split));

    System.out.println(
        "JAVA_CASES_STDOUT_完成:" + environmentValue + ":" + ProjectFileUtil.getEnvIP());
    // Keep the attempt running long enough for the UI real-time log capture
    // assertion to observe the stdout marker while the attempt is still active.
    Thread.sleep(3_000);
    System.err.println("WARN simulated slow dependency probe before final assertion");
    System.err.println("JAVA_CASES_STDERR_CAPTURED");

    Path artifact = Path.of("artifacts", "java-cases.txt");
    Files.createDirectories(artifact.getParent());
    Files.writeString(artifact, "JAVA_CASES_ARTIFACT_SAFE\n", StandardCharsets.UTF_8);
  }
}
