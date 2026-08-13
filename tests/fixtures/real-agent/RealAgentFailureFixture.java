package com.autoforge.acceptance;

import org.testng.Assert;
import org.testng.annotations.Test;

public final class RealAgentFailureFixture {
  @Test(groups = {"real-agent", "failure"}, description = "Fails after emitting split redacted output")
  public void failsAfterRealProcessOutput() throws Exception {
    String secret = System.getenv("AUTOFORGE_REAL_AGENT_SECRET");
    Assert.assertNotNull(secret, "The managed secret was not injected into the failing process.");
    int split = secret.length() / 2;
    System.out.print("REAL_FAILURE_SECRET_PROBE=" + secret.substring(0, split));
    System.out.flush();
    Thread.sleep(100L);
    System.out.println(secret.substring(split));
    System.err.println("REAL_AGENT_FAILURE_STDERR_中文");
    Assert.fail("AUTOFORGE_INTENTIONAL_REAL_AGENT_FAILURE");
  }
}
