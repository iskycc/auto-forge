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
    // 让 attempt 的 running 窗口足够长，控制面轮询才能稳定观察到运行中状态并验证实时日志。
    Thread.sleep(3_000L);
    Assert.assertEquals(
        ProjectFileUtil.getEnvIP(),
        "10.0.0.11",
        "The task-scoped Adapter environment address was not injected.");
    System.out.println("REAL_AGENT_STDOUT_中文_完成:" + ProjectFileUtil.getEnvIP());
    System.err.println("REAL_AGENT_STDERR_CAPTURED");
    Path artifact = Path.of("artifacts", "real-agent.txt");
    Files.createDirectories(artifact.getParent());
    Files.writeString(artifact, "REAL_AGENT_ARTIFACT_SAFE\n", StandardCharsets.UTF_8);
  }
}
