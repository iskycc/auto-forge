package com.autoforge.acceptance;

import org.testng.annotations.Test;

public final class RealAgentRestartFixture {
  @Test(groups = {"real-agent", "reconcile"}, description = "Remains active until the Agent is killed")
  public void waitsForAgentRestartReconciliation() throws Exception {
    System.out.println("REAL_AGENT_RESTART_FIXTURE_STARTED");
    System.out.flush();
    Thread.sleep(120_000L);
  }
}
