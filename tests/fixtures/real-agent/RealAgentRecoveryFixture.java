package com.autoforge.acceptance;

import org.testng.annotations.Test;

public final class RealAgentRecoveryFixture {
  @Test(groups = {"real-agent", "recovery"}, description = "Keeps a real execution active during Full dependency faults")
  public void survivesTransientFullDependencyFailure() throws Exception {
    System.out.println("REAL_AGENT_FULL_RECOVERY_STARTED");
    System.out.flush();
    Thread.sleep(5_000L);
  }
}
