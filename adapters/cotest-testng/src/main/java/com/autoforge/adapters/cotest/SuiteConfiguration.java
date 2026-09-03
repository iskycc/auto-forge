package com.autoforge.adapters.cotest;

final class SuiteConfiguration {
  static final String DEFAULT_SUITE_NAME = "AutoForge adapter suite";
  static final String DEFAULT_TEST_NAME = "AutoForge adapter test";

  private final String suiteName;
  private final String testName;

  SuiteConfiguration(String suiteName, String testName) {
    this.suiteName = requireName(suiteName, "suite");
    this.testName = requireName(testName, "test");
  }

  String suiteName() {
    return suiteName;
  }

  String testName() {
    return testName;
  }

  private static String requireName(String value, String kind) {
    if (TextValues.isBlank(value)) {
      throw new IllegalArgumentException("The TestNG " + kind + " name must not be blank.");
    }
    return value;
  }
}
