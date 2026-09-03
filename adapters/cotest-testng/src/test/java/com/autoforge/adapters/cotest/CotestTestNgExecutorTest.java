package com.autoforge.adapters.cotest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.net.MalformedURLException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class CotestTestNgExecutorTest {
  private static final List<String> FIXTURE_CLASSES =
      Arrays.asList(
          "com/huawei/cotest/util/ProjectFileUtil.class",
          "cotest/auto/dataproviders/MM2DataProvider.class",
          "fixture/AdapterCase.class",
          "fixture/AdapterFailingCase.class",
          "fixture/AdapterSkippedCase.class");

  @TempDir Path temporaryDirectory;

  @Test
  void executesATestNgCaseWithAllRuntimeTypesLoadedFromTheIsolatedClasspath()
      throws IOException {
    Path fixtureJar = createFixtureJar();
    Path classDataFile = temporaryDirectory.resolve("class-data.json");
    Utf8TestIO.write(classDataFile, "{}\n");
    Path reports = temporaryDirectory.resolve("reports");
    ByteArrayOutputStream standardOutput = new ByteArrayOutputStream();
    ByteArrayOutputStream errorOutput = new ByteArrayOutputStream();
    ClassLoader originalContextLoader = Thread.currentThread().getContextClassLoader();

    AdapterExecutionRequest request =
        new AdapterExecutionRequest(
            runtimeUrls(fixtureJar),
            "fixture.AdapterCase",
            new SuiteConfiguration("Adapter suite", "Adapter test"),
            "10.0.0.8",
            classDataFile,
            reports);
    int exitCode;
    try (PrintStream output = AdapterMain.utf8PrintStream(standardOutput);
        PrintStream errors = AdapterMain.utf8PrintStream(errorOutput)) {
      exitCode = new CotestTestNgExecutor(output, errors).execute(request);
    }

    assertEquals(0, exitCode, Utf8TestIO.decode(errorOutput));
    assertSame(originalContextLoader, Thread.currentThread().getContextClassLoader());
    assertTrue(Utf8TestIO.decode(standardOutput).contains("Passed: 1"));
    assertTrue(Files.isRegularFile(reports.resolve("testng-results.xml")));
  }

  @Test
  void skippedTestsDoNotTurnTheProcessExitCodeIntoAFailure() throws IOException {
    Path fixtureJar = createFixtureJar();
    Path classDataFile = temporaryDirectory.resolve("class-data.json");
    Utf8TestIO.write(classDataFile, "{}\n");
    Path reports = temporaryDirectory.resolve("reports-skipped");
    ByteArrayOutputStream standardOutput = new ByteArrayOutputStream();
    ByteArrayOutputStream errorOutput = new ByteArrayOutputStream();

    AdapterExecutionRequest request =
        new AdapterExecutionRequest(
            runtimeUrls(fixtureJar),
            "fixture.AdapterSkippedCase",
            new SuiteConfiguration("Adapter suite", "Adapter test"),
            "10.0.0.8",
            classDataFile,
            reports);
    int exitCode;
    try (PrintStream output = AdapterMain.utf8PrintStream(standardOutput);
        PrintStream errors = AdapterMain.utf8PrintStream(errorOutput)) {
      exitCode = new CotestTestNgExecutor(output, errors).execute(request);
    }

    String stdout = Utf8TestIO.decode(standardOutput);
    assertTrue(stdout.contains("Passed: 1"), stdout);
    assertTrue(stdout.contains("Skipped: 1"), stdout);
    // TestNG 状态位图包含跳过位（status=2），但退出码必须为 0，由控制面按 XML 判定结果。
    assertTrue(stdout.contains("TestNG exit status: 2"), stdout);
    assertEquals(0, exitCode, Utf8TestIO.decode(errorOutput));
  }

  @Test
  void emitsTheCompleteFailureMarkerBeforeThePotentiallyLongStackTrace() throws IOException {
    Path fixtureJar = createFixtureJar();
    Path classDataFile = temporaryDirectory.resolve("class-data-failure.json");
    Utf8TestIO.write(classDataFile, "{}\n");
    ByteArrayOutputStream standardOutput = new ByteArrayOutputStream();
    ByteArrayOutputStream errorOutput = new ByteArrayOutputStream();
    AdapterExecutionRequest request =
        new AdapterExecutionRequest(
            runtimeUrls(fixtureJar),
            "fixture.AdapterFailingCase",
            new SuiteConfiguration("Adapter suite", "Adapter test"),
            "10.0.0.8",
            classDataFile,
            temporaryDirectory.resolve("reports-failure"));

    int exitCode;
    try (PrintStream output = AdapterMain.utf8PrintStream(standardOutput);
        PrintStream errors = AdapterMain.utf8PrintStream(errorOutput)) {
      exitCode = new CotestTestNgExecutor(output, errors).execute(request);
    }

    String stdout = Utf8TestIO.decode(standardOutput);
    int markerStart = stdout.indexOf(FailureSummaryMarker.PREFIX + "[");
    int markerEnd = stdout.indexOf(']', markerStart);
    assertEquals(1, exitCode);
    assertTrue(markerStart >= 0, stdout);
    assertTrue(markerEnd > markerStart, stdout);
    assertTrue(markerStart < stdout.indexOf("Stack Trace:"), stdout);
    String payload =
        stdout.substring(markerStart + (FailureSummaryMarker.PREFIX + "[").length(), markerEnd);
    String summary =
        new String(Base64.getDecoder().decode(payload), StandardCharsets.UTF_8);
    assertTrue(summary.contains("中文断言失败 mixed English"), summary);
    assertTrue(summary.contains("第二行错误详情 OrderId 不能为空"), summary);
    assertTrue(!summary.contains("???"), summary);
  }

  private Path createFixtureJar() throws IOException {
    Path fixtureJar = temporaryDirectory.resolve("adapter-fixtures.jar");
    try (JarOutputStream archive = new JarOutputStream(Files.newOutputStream(fixtureJar))) {
      for (String resourceName : FIXTURE_CLASSES) {
        archive.putNextEntry(new JarEntry(resourceName));
        try (java.io.InputStream contents =
            getClass().getClassLoader().getResourceAsStream(resourceName)) {
          if (contents == null) {
            throw new IOException("Missing compiled test fixture: " + resourceName);
          }
          Utf8TestIO.copy(contents, archive);
        }
        archive.closeEntry();
      }
    }
    return fixtureJar;
  }

  private static List<URL> runtimeUrls(Path fixtureJar) throws MalformedURLException {
    List<URL> urls = new ArrayList<>();
    urls.add(fixtureJar.toUri().toURL());
    String[] classpathEntries =
        System.getProperty("java.class.path").split(java.io.File.pathSeparator);
    for (String entry : classpathEntries) {
      Path path = Paths.get(entry);
      if (Files.isRegularFile(path) && entry.endsWith(".jar")) {
        urls.add(path.toUri().toURL());
      }
    }
    return Collections.unmodifiableList(urls);
  }
}
