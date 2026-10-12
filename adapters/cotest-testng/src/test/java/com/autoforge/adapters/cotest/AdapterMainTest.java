package com.autoforge.adapters.cotest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Base64;
import java.util.concurrent.TimeUnit;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class AdapterMainTest {
  @TempDir Path temporaryDirectory;

  @Test
  void createsUtf8ConsoleStreamsIndependentOfTheHostDefault() {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    try (PrintStream output = AdapterMain.utf8PrintStream(bytes)) {
      output.print("中文 assertion message");
    }

    assertEquals("中文 assertion message", Utf8TestIO.decode(bytes));
  }

  @Test
  void abortsWithTheTimeoutExitCodeWhenTheCaseExceedsTheLimit()
      throws IOException, InterruptedException {
    Path jarDirectory = createJarDirectory("fixture/AdapterSlowCase.class");
    Path consoleLog = temporaryDirectory.resolve("adapter-console.log");
    String javaExecutable = Paths.get(System.getProperty("java.home"), "bin", "java").toString();
    String classPath =
        System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
    // Timeout cleanup belongs to main's process exit; run() alone leaves TestNG threads alive.
    Process adapter =
        new ProcessBuilder(
                javaExecutable,
                "-cp", classPath,
                AdapterMain.class.getName(),
                "--jars", jarDirectory.toString(),
                "--class", "fixture.AdapterSlowCase",
                "--output", temporaryDirectory.resolve("reports").toString(),
                "--case-timeout-seconds", "1")
            .redirectErrorStream(true)
            .redirectOutput(consoleLog.toFile())
            .start();
    try {
      assertTrue(adapter.waitFor(20, TimeUnit.SECONDS), "Adapter did not exit after its timeout");
      String stdout = new String(Files.readAllBytes(consoleLog), StandardCharsets.UTF_8);
      assertEquals(AdapterMain.CASE_TIMEOUT_EXIT_CODE, adapter.exitValue(), stdout);
      assertTrue(stdout.contains("TestCase Execution Timeout"), stdout);
    } finally {
      if (adapter.isAlive()) {
        adapter.destroyForcibly();
        assertTrue(adapter.waitFor(5, TimeUnit.SECONDS), "Unable to stop the Adapter test process");
      }
    }
  }

  @Test
  void ordinaryCasesIgnoreHistoricalDdtUrlsEvenWhenTheProviderIsPresent() throws IOException {
    Path jarDirectory =
        createJarDirectory(
            "cotest/auto/dataproviders/MM2DataProvider.class",
            "fixture/AdapterOrdinaryCase.class");
    ByteArrayOutputStream standardOutput = new ByteArrayOutputStream();
    ByteArrayOutputStream errorOutput = new ByteArrayOutputStream();
    try (PrintStream output = AdapterMain.utf8PrintStream(standardOutput);
        PrintStream errors = AdapterMain.utf8PrintStream(errorOutput)) {
      int exitCode =
          AdapterMain.run(
              new String[] {
                "--jars", jarDirectory.toString(),
                "--class", "fixture.AdapterOrdinaryCase",
                "--ddt-insight-url", "http://platform:3100/api/v1/public/ddt/projects/p/versions/v/stages/s/case",
                "--output", temporaryDirectory.resolve("reports-ordinary").toString()
              },
              output,
              errors);
      assertEquals(0, exitCode, Utf8TestIO.decode(errorOutput));
      assertFalse(Utf8TestIO.decode(standardOutput).contains("Configured DDT"));
    }
  }

  @ParameterizedTest
  @ValueSource(strings = {"C", "C.UTF-8"})
  void preservesDdtCaseIdAcrossLauncherLocales(String locale)
      throws IOException, InterruptedException {
    Path jarDirectory =
        createJarDirectory(
            "com/huawei/cotest/util/ProjectFileUtil.class",
            "cotest/auto/dataproviders/MM2DataProvider.class",
            "fixture/AdapterCase.class");
    Path consoleLog = temporaryDirectory.resolve("ddt-console.log");
    String javaExecutable = Paths.get(System.getProperty("java.home"), "bin", "java").toString();
    String classPath =
        System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
    String encodedCaseId =
        Base64.getEncoder().encodeToString("CASE/0001 中文?x=1".getBytes(StandardCharsets.UTF_8));
    ProcessBuilder launcher =
        new ProcessBuilder(
            javaExecutable,
            "-Xmx128m",
            "-Dfile.encoding=UTF-8",
            "-cp", classPath,
            AdapterMain.class.getName(),
            "--jars", jarDirectory.toString(),
            "--class", "fixture.AdapterCase",
            "--environment-address", "10.0.0.8",
            "--case-id-base64", encodedCaseId,
            "--ddt-insight-url", "http://platform:3100/api/v1/public/ddt/projects/p/versions/v/stages/s/case",
            "--output", temporaryDirectory.resolve("reports-ddt").toString(),
            "--case-timeout-seconds", "10");
    launcher.environment().put("LANG", locale);
    launcher.environment().put("LC_ALL", locale);
    Process adapter = launcher.redirectErrorStream(true).redirectOutput(consoleLog.toFile()).start();
    try {
      assertTrue(adapter.waitFor(20, TimeUnit.SECONDS), "DDT Adapter did not exit");
      String stdout = new String(Files.readAllBytes(consoleLog), StandardCharsets.UTF_8);
      assertEquals(0, adapter.exitValue(), stdout);
      assertTrue(
          stdout.contains("Configured DDT CaseID for fixture.AdapterCase: CASE/0001 中文?x=1"), stdout);
      assertTrue(Files.isRegularFile(temporaryDirectory.resolve("reports-ddt/testng-results.xml")));
    } finally {
      if (adapter.isAlive()) {
        adapter.destroyForcibly();
        assertTrue(adapter.waitFor(5, TimeUnit.SECONDS), "Unable to stop the DDT Adapter test process");
      }
    }
  }

  @Test
  void completesNormallyWhenTheCaseFinishesWithinTheLimit() throws IOException {
    Path jarDirectory =
        createJarDirectory(
            "com/huawei/cotest/util/ProjectFileUtil.class",
            "cotest/auto/dataproviders/MM2DataProvider.class",
            "fixture/AdapterCase.class");
    ByteArrayOutputStream standardOutput = new ByteArrayOutputStream();
    ByteArrayOutputStream errorOutput = new ByteArrayOutputStream();

    int exitCode;
    try (PrintStream output = AdapterMain.utf8PrintStream(standardOutput);
        PrintStream errors = AdapterMain.utf8PrintStream(errorOutput)) {
      exitCode =
          AdapterMain.run(
              new String[] {
                "--jars", jarDirectory.toString(),
                "--class", "fixture.AdapterCase",
                "--environment-address", "10.0.0.8",
                "--case-id", "CASE/0001 中文?x=1",
                "--ddt-insight-url", "http://platform:3100/api/v1/public/ddt/projects/p/versions/v/stages/s/case",
                "--output", temporaryDirectory.resolve("reports-ok").toString(),
                "--case-timeout-seconds", "600"
              },
              output,
              errors);
    }

    assertEquals(0, exitCode, Utf8TestIO.decode(errorOutput));
  }

  private Path createJarDirectory(String... fixtureClasses) throws IOException {
    Path jarDirectory = temporaryDirectory.resolve("test-jars");
    Files.createDirectories(jarDirectory);
    Path fixtureJar = jarDirectory.resolve("autoforge-case.jar");
    try (JarOutputStream archive = new JarOutputStream(Files.newOutputStream(fixtureJar))) {
      for (String resourceName : fixtureClasses) {
        archive.putNextEntry(new JarEntry(resourceName));
        try (InputStream contents = getClass().getClassLoader().getResourceAsStream(resourceName)) {
          if (contents == null) {
            throw new IOException("Missing compiled test fixture: " + resourceName);
          }
          Utf8TestIO.copy(contents, archive);
        }
        archive.closeEntry();
      }
    }
    return jarDirectory;
  }
}
