package com.autoforge.adapters.cotest;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

final class AdapterArguments {
  static final String USAGE =
      "Usage: java -jar cotest-testng-adapter.jar "
          + "--jars DIR --class CLASS [--environment-address VALUE] "
          + "[--class-data FILE] [--config FILE] [--suite-name NAME] "
          + "[--test-name NAME] [--output DIR]";

  private final Path jarDirectory;
  private final String className;
  private final String environmentAddress;
  private final Path classDataFile;
  private final Path configurationFile;
  private final String suiteName;
  private final String testName;
  private final Path outputDirectory;

  private AdapterArguments(Map<String, String> options) {
    jarDirectory = Path.of(required(options, "--jars"));
    className = required(options, "--class");
    environmentAddress = options.getOrDefault("--environment-address", "");
    classDataFile = optionalPath(options, "--class-data");
    configurationFile = optionalPath(options, "--config");
    suiteName = options.get("--suite-name");
    testName = options.get("--test-name");
    outputDirectory = Path.of(options.getOrDefault("--output", "reports/testng"));
    if (!isBinaryClassName(className)) {
      throw new IllegalArgumentException("--class must be a Java binary class name.");
    }
  }

  static AdapterArguments parse(String[] arguments) {
    if (arguments.length == 0 || arguments.length % 2 != 0) {
      throw new IllegalArgumentException(USAGE);
    }
    Map<String, String> options = new HashMap<>();
    for (int index = 0; index < arguments.length; index += 2) {
      String option = arguments[index];
      if (!isSupported(option)) {
        throw new IllegalArgumentException("Unsupported option: " + option + ". " + USAGE);
      }
      String value = arguments[index + 1];
      if (value.isBlank() || options.putIfAbsent(option, value) != null) {
        throw new IllegalArgumentException("Missing or duplicate value for " + option + ".");
      }
    }
    return new AdapterArguments(options);
  }

  Path jarDirectory() {
    return jarDirectory;
  }

  String className() {
    return className;
  }

  String environmentAddress() {
    return environmentAddress;
  }

  Path classDataFile() {
    return classDataFile;
  }

  Path configurationFile() {
    return configurationFile;
  }

  String suiteName() {
    return suiteName;
  }

  String testName() {
    return testName;
  }

  Path outputDirectory() {
    return outputDirectory;
  }

  private static String required(Map<String, String> options, String name) {
    String value = options.get(name);
    if (value == null) {
      throw new IllegalArgumentException("Missing required option " + name + ". " + USAGE);
    }
    return value;
  }

  private static Path optionalPath(Map<String, String> options, String name) {
    String value = options.get(name);
    return value == null ? null : Path.of(value);
  }

  private static boolean isSupported(String option) {
    switch (option) {
      case "--jars":
      case "--class":
      case "--environment-address":
      case "--class-data":
      case "--config":
      case "--suite-name":
      case "--test-name":
      case "--output":
        return true;
      default:
        return false;
    }
  }

  private static boolean isBinaryClassName(String value) {
    String[] segments = value.split("\\.", -1);
    for (String segment : segments) {
      if (segment.isEmpty() || !Character.isJavaIdentifierStart(segment.charAt(0))) {
        return false;
      }
      for (int index = 1; index < segment.length(); index++) {
        if (!Character.isJavaIdentifierPart(segment.charAt(index))) {
          return false;
        }
      }
    }
    return true;
  }
}
