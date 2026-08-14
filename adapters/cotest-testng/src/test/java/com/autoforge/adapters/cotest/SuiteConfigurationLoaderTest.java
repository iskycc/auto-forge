package com.autoforge.adapters.cotest;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SuiteConfigurationLoaderTest {
  @TempDir Path temporaryDirectory;

  @Test
  void readsFirstTwoMeaningfulLinesAndAllowsExplicitOverrides() throws IOException {
    Path configuration = temporaryDirectory.resolve("adapter.conf");
    Files.writeString(
        configuration, "# names\n\nConfigured suite\nConfigured test\nIgnored value\n");

    SuiteConfiguration loaded =
        new SuiteConfigurationLoader().load(configuration, null, "Explicit test");

    assertEquals("Configured suite", loaded.suiteName());
    assertEquals("Explicit test", loaded.testName());
  }

  @Test
  void usesStableDefaultsWithoutAConfigurationFile() {
    SuiteConfiguration loaded = new SuiteConfigurationLoader().load(null, null, null);

    assertEquals(SuiteConfiguration.DEFAULT_SUITE_NAME, loaded.suiteName());
    assertEquals(SuiteConfiguration.DEFAULT_TEST_NAME, loaded.testName());
  }
}
