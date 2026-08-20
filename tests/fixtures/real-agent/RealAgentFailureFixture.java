package com.autoforge.acceptance;

import org.testng.Assert;
import org.testng.annotations.Test;

public final class RealAgentFailureFixture {
  @Test(groups = {"real-agent", "failure"}, description = "Fails after emitting real process output")
  public void failsAfterRealProcessOutput() throws Exception {
    System.out.println("REAL_AGENT_FAILURE_STDOUT_中文");
    System.err.println("REAL_AGENT_FAILURE_STDERR_中文");
    Assert.fail("AUTOFORGE_INTENTIONAL_REAL_AGENT_FAILURE");
  }
}
