package com.autoforge.acceptance;

import com.huawei.cotest.util.ProjectFileUtil;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.testng.Assert;
import org.testng.annotations.Test;

public final class RealAgentFixture {
  @Test(groups = {"real-agent", "smoke"}, description = "Runs in the real offline Agent toolchain")
  public void executesThroughRealAgent() throws Exception {
    String environmentValue = System.getenv("AUTOFORGE_REAL_AGENT_ENV");
    String secret = System.getenv("AUTOFORGE_REAL_AGENT_SECRET");
    Assert.assertEquals(
        environmentValue, "workflow-v2", "The immutable environment version was not injected.");
    Assert.assertEquals(
        secret,
        "real-agent-secret-v1-do-not-leak-8f31",
        "The secret version bound to the environment snapshot was not injected.");
    Assert.assertEquals(
        ProjectFileUtil.getEnvIP(),
        "10.0.0.11",
        "The task-scoped Adapter environment address was not injected.");
    int split = secret.length() / 2;
    System.out.print("REAL_AGENT_SECRET_PROBE=" + secret.substring(0, split));
    System.out.flush();
    Thread.sleep(100L);
    System.out.println(secret.substring(split));
    System.out.println("REAL_AGENT_STDOUT_中文_完成:" + environmentValue);
    System.err.println("REAL_AGENT_STDERR_CAPTURED");
    Path artifact = Path.of("artifacts", "real-agent.txt");
    Files.createDirectories(artifact.getParent());
    Files.writeString(artifact, "REAL_AGENT_ARTIFACT_SAFE\n", StandardCharsets.UTF_8);
  }
}
