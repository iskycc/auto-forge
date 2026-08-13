package com.autoforge.acceptance;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.testng.annotations.Test;

public final class RealAgentRecoveryFixture {
  @Test(groups = {"real-agent", "recovery"}, description = "Keeps a real execution active during Full dependency faults")
  public void survivesTransientFullDependencyFailure() throws Exception {
    System.out.println("REAL_AGENT_FULL_RECOVERY_STARTED");
    System.out.flush();
    Thread.sleep(5_000L);
    Path artifact = Path.of("artifacts", "full-recovery.txt");
    Files.createDirectories(artifact.getParent());
    Files.writeString(artifact, "FULL_RECOVERY_ARTIFACT\n", StandardCharsets.UTF_8);
  }
}
