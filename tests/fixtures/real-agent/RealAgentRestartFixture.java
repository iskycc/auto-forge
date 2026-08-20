package com.autoforge.acceptance;

import com.huawei.cotest.util.ProjectFileUtil;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.testng.Assert;
import org.testng.annotations.Test;

public final class RealAgentRestartFixture {
  @Test(groups = {"real-agent", "reconcile"}, description = "Remains active until the Agent is killed")
  public void waitsForAgentRestartReconciliation() throws Exception {
    String markerValue = ProjectFileUtil.getEnvIP();
    Assert.assertFalse(markerValue.isBlank(), "The restart-attempt marker path was not configured.");
    Path marker = Path.of(markerValue);
    try {
      Files.createFile(marker);
    } catch (FileAlreadyExistsException retry) {
      System.out.println("REAL_AGENT_RESTART_FIXTURE_RECOVERED");
      return;
    }
    System.out.println("REAL_AGENT_RESTART_FIXTURE_STARTED");
    System.out.flush();
    Thread.sleep(120_000L);
  }
}
