package com.autoforge.adapters.cotest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.nio.file.Path;
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

    assertEquals(Path.of("/opt/cotest/jars"), arguments.jarDirectory());
    assertEquals("example.AdapterCase", arguments.className());
    assertEquals("10.0.0.8", arguments.environmentAddress());
    assertEquals(Path.of("/opt/cotest/data.json"), arguments.classDataFile());
    assertEquals("Regression", arguments.suiteName());
    assertEquals("Adapter cases", arguments.testName());
    assertEquals(Path.of("/tmp/testng-output"), arguments.outputDirectory());
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
}
