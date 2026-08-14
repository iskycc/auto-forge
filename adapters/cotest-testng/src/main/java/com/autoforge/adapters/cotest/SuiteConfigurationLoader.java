package com.autoforge.adapters.cotest;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

final class SuiteConfigurationLoader {
  private static final int CONFIGURATION_VALUE_COUNT = 2;

  SuiteConfiguration load(Path configurationFile, String explicitSuiteName, String explicitTestName) {
    List<String> configuredNames =
        configurationFile == null ? List.of() : readConfiguredNames(configurationFile);
    String suiteName =
        firstNonBlank(
            explicitSuiteName,
            configuredNames.size() > 0 ? configuredNames.get(0) : null,
            SuiteConfiguration.DEFAULT_SUITE_NAME);
    String testName =
        firstNonBlank(
            explicitTestName,
            configuredNames.size() > 1 ? configuredNames.get(1) : null,
            SuiteConfiguration.DEFAULT_TEST_NAME);
    return new SuiteConfiguration(suiteName, testName);
  }

  private List<String> readConfiguredNames(Path configurationFile) {
    List<String> values = new ArrayList<>(CONFIGURATION_VALUE_COUNT);
    try (BufferedReader reader =
        Files.newBufferedReader(configurationFile, StandardCharsets.UTF_8)) {
      String line;
      while ((line = reader.readLine()) != null && values.size() < CONFIGURATION_VALUE_COUNT) {
        String candidate = line.trim();
        if (!candidate.isEmpty() && !candidate.startsWith("#")) {
          values.add(candidate);
        }
      }
    } catch (IOException error) {
      throw new IllegalArgumentException(
          "Cannot read TestNG suite configuration: " + configurationFile, error);
    }
    return values;
  }

  private static String firstNonBlank(String... values) {
    for (String value : values) {
      if (value != null && !value.isBlank()) {
        return value;
      }
    }
    throw new IllegalArgumentException("No non-blank configuration value is available.");
  }
}
