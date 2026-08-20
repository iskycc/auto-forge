package com.autoforge.adapters.cotest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AdapterMainTest {
  @TempDir Path temporaryDirectory;

  @Test
  void createsUtf8ConsoleStreamsIndependentOfTheHostDefault() {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    try (PrintStream output = AdapterMain.utf8PrintStream(bytes)) {
      output.print("中文 assertion message");
    }

    assertEquals("中文 assertion message", bytes.toString(StandardCharsets.UTF_8));
  }

  @Test
  void abortsWithTheTimeoutExitCodeWhenTheCaseExceedsTheLimit() throws IOException {
    Path jarDirectory = createJarDirectory("fixture/AdapterSlowCase.class");
    ByteArrayOutputStream standardOutput = new ByteArrayOutputStream();
    ByteArrayOutputStream errorOutput = new ByteArrayOutputStream();

    int exitCode;
    try (PrintStream output = new PrintStream(standardOutput, true, StandardCharsets.UTF_8);
        PrintStream errors = new PrintStream(errorOutput, true, StandardCharsets.UTF_8)) {
      exitCode =
          AdapterMain.run(
              new String[] {
                "--jars", jarDirectory.toString(),
                "--class", "fixture.AdapterSlowCase",
                "--output", temporaryDirectory.resolve("reports").toString(),
                "--case-timeout-seconds", "1"
              },
              output,
              errors);
    }

    String stdout = standardOutput.toString(StandardCharsets.UTF_8);
    assertEquals(AdapterMain.CASE_TIMEOUT_EXIT_CODE, exitCode, stdout);
    assertTrue(stdout.contains("TestCase Execution Timeout"), stdout);
  }

  @Test
  void completesNormallyWhenTheCaseFinishesWithinTheLimit() throws IOException {
    Path jarDirectory =
        createJarDirectory(
            "com/huawei/cotest/util/ProjectFileUtil.class",
            "cotest/auto/dataproviders/MM2DataProvider.class",
            "fixture/AdapterCase.class");
    Path classDataFile = temporaryDirectory.resolve("class-data.json");
    Files.writeString(classDataFile, "{}\n");
    ByteArrayOutputStream standardOutput = new ByteArrayOutputStream();
    ByteArrayOutputStream errorOutput = new ByteArrayOutputStream();

    int exitCode;
    try (PrintStream output = new PrintStream(standardOutput, true, StandardCharsets.UTF_8);
        PrintStream errors = new PrintStream(errorOutput, true, StandardCharsets.UTF_8)) {
      exitCode =
          AdapterMain.run(
              new String[] {
                "--jars", jarDirectory.toString(),
                "--class", "fixture.AdapterCase",
                "--environment-address", "10.0.0.8",
                "--class-data", classDataFile.toString(),
                "--output", temporaryDirectory.resolve("reports-ok").toString(),
                "--case-timeout-seconds", "600"
              },
              output,
              errors);
    }

    assertEquals(0, exitCode, errorOutput.toString(StandardCharsets.UTF_8));
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
          contents.transferTo(archive);
        }
        archive.closeEntry();
      }
    }
    return jarDirectory;
  }
}
