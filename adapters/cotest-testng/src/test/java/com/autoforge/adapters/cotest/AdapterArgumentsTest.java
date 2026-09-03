package com.autoforge.adapters.cotest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.nio.file.Paths;
import org.junit.jupiter.api.Test;

class AdapterArgumentsTest {
  @Test
  void parsesRequiredAndOptionalArguments() {
    AdapterArguments arguments =
        AdapterArguments.parse(
            new String[] {
              "--jars", "/opt/cotest/jars",
              "--class", "example.AdapterCase",
              "--environment-address", "10.0.0.8",
              "--class-data", "/opt/cotest/data.json",
              "--suite-name", "Regression",
              "--test-name", "Adapter cases",
              "--output", "/tmp/testng-output"
            });

    assertEquals(Paths.get("/opt/cotest/jars"), arguments.jarDirectory());
    assertEquals("example.AdapterCase", arguments.className());
    assertEquals("10.0.0.8", arguments.environmentAddress());
    assertEquals(Paths.get("/opt/cotest/data.json"), arguments.classDataFile());
    assertEquals("Regression", arguments.suiteName());
    assertEquals("Adapter cases", arguments.testName());
    assertEquals(Paths.get("/tmp/testng-output"), arguments.outputDirectory());
    assertEquals(AdapterArguments.DEFAULT_CASE_TIMEOUT_SECONDS, arguments.caseTimeoutSeconds());
  }

  @Test
  void parsesAnExplicitCaseTimeout() {
    AdapterArguments arguments =
        AdapterArguments.parse(
            new String[] {
              "--jars", "/opt/cotest/jars",
              "--class", "example.AdapterCase",
              "--case-timeout-seconds", "120"
            });

    assertEquals(120, arguments.caseTimeoutSeconds());
  }

  @Test
  void rejectsInvalidCaseTimeoutValues() {
    for (String invalid : new String[] {"0", "-5", "not-a-number", "86401"}) {
      assertThrows(
          IllegalArgumentException.class,
          () ->
              AdapterArguments.parse(
                  new String[] {
                    "--jars", "/opt/cotest/jars",
                    "--class", "example.AdapterCase",
                    "--case-timeout-seconds", invalid
                  }),
          "expected " + invalid + " to be rejected");
    }
  }

  @Test
  void rejectsDuplicateAndMalformedOptions() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            AdapterArguments.parse(
                new String[] {
                  "--jars", "one", "--jars", "two", "--class", "example.Case",
                  "--environment-address", "127.0.0.1"
                }));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            AdapterArguments.parse(
                new String[] {
                  "--jars", "jars", "--class", "not/a/class",
                  "--environment-address", "127.0.0.1"
                }));
  }

  @Test
  void rejectsUnicodeWhitespaceValuesOnJava8() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            AdapterArguments.parse(
                new String[] {
                  "--jars", "\u2003", "--class", "example.Case"
                }));
  }
}
