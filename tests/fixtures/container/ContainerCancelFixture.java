package com.autoforge.acceptance;

import org.testng.annotations.Test;

public final class ContainerCancelFixture {
  @Test
  public void waitsForControlPlaneCancellation() throws Exception {
    System.out.println("CONTAINER_CANCEL_STARTED");
    System.out.flush();
    Thread.sleep(120_000L);
  }
}
