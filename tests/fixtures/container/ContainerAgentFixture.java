package com.autoforge.acceptance;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;
import org.testng.Assert;
import org.testng.annotations.Test;

public final class ContainerAgentFixture {
  @Test
  public void enforcesContainerPolicy() throws Exception {
    String mode = System.getenv("AUTOFORGE_CONTAINER_MODE");
    Assert.assertNotNull(mode, "The container execution mode must be injected.");
    if (mode.equals("cancel")) {
      System.out.println("CONTAINER_CANCEL_STARTED");
      System.out.flush();
      Thread.sleep(120_000L);
      return;
    }

    Assert.assertEquals(mode, "success");
    String processStatus = Files.readString(Path.of("/proc/self/status"));
    Assert.assertTrue(processStatus.matches("(?ms).*^Uid:\\s+[1-9][0-9]*\\s+.*$.*"), processStatus);
    Assert.assertTrue(processStatus.matches("(?ms).*^CapEff:\\s+0+\\s*$.*"), processStatus);
    Assert.assertTrue(processStatus.matches("(?ms).*^NoNewPrivs:\\s+1\\s*$.*"), processStatus);
    assertRootFilesystemIsReadOnly();
    assertOutboundNetworkIsBlocked();
    assertResourceLimits();

    System.out.println("CONTAINER_POLICY_STDOUT_中文_完成");
    System.err.println("CONTAINER_POLICY_STDERR_CAPTURED");
  }

  private static void assertRootFilesystemIsReadOnly() {
    try {
      Files.writeString(Path.of("/opt/autoforge/container-write-probe"), "must fail");
      Assert.fail("The container root filesystem unexpectedly accepted a write.");
    } catch (IOException expected) {
      Assert.assertFalse(Files.exists(Path.of("/opt/autoforge/container-write-probe")));
    }
  }

  private static void assertOutboundNetworkIsBlocked() {
    try (Socket socket = new Socket()) {
      socket.connect(new InetSocketAddress("203.0.113.1", 443), 1_000);
      Assert.fail("The isolated execution container unexpectedly reached an external address.");
    } catch (IOException expected) {
      // Docker's network=none must make the connection fail before any application data is sent.
    }
  }

  private static void assertResourceLimits() throws IOException {
    Assert.assertEquals(Files.readString(Path.of("/sys/fs/cgroup/pids.max")).trim(), "256");
    Assert.assertEquals(
        Files.readString(Path.of("/sys/fs/cgroup/memory.max")).trim(), "2147483648");
    String cpuLimit = Files.readString(Path.of("/sys/fs/cgroup/cpu.max")).trim();
    Assert.assertTrue(cpuLimit.matches("[1-9][0-9]* [1-9][0-9]*"), cpuLimit);
    Assert.assertEquals(Files.getFileStore(Path.of("/tmp")).getTotalSpace(), 67_108_864L);
  }
}
