package com.autoforge.adapters.cotest;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;

final class AdapterArguments {
  static final int DEFAULT_CASE_TIMEOUT_SECONDS = 600;
  static final int MAXIMUM_CASE_TIMEOUT_SECONDS = 86_400;

  static final String USAGE =
      "Usage: java -jar cotest-testng-adapter.jar "
          + "--jars DIR --class CLASS [--environment-address VALUE] "
          + "[--class-data FILE] [--config FILE] [--suite-name NAME] "
          + "[--test-name NAME] [--output DIR] [--case-timeout-seconds SECONDS]";

  private final Path jarDirectory;
  private final String className;
  private final String environmentAddress;
  private final Path classDataFile;
  private final Path configurationFile;
  private final String suiteName;
  private final String testName;
  private final Path outputDirectory;
  private final int caseTimeoutSeconds;

  private AdapterArguments(Map<String, String> options) {
    jarDirectory = Paths.get(required(options, "--jars"));
    className = required(options, "--class");
    environmentAddress = options.getOrDefault("--environment-address", "");
    classDataFile = optionalPath(options, "--class-data");
    configurationFile = optionalPath(options, "--config");
    suiteName = options.get("--suite-name");
    testName = options.get("--test-name");
    outputDirectory = Paths.get(options.getOrDefault("--output", "reports/testng"));
    caseTimeoutSeconds = caseTimeoutSeconds(options);
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
      if (TextValues.isBlank(value) || options.putIfAbsent(option, value) != null) {
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

  // 用例执行超时（秒）：由 adapter 自行看门狗强制中断执行；控制面可通过
  // --case-timeout-seconds 覆盖，缺省 600 秒。
  int caseTimeoutSeconds() {
    return caseTimeoutSeconds;
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
    return value == null ? null : Paths.get(value);
  }

  private static int caseTimeoutSeconds(Map<String, String> options) {
    String value = options.get("--case-timeout-seconds");
    if (value == null) {
      return DEFAULT_CASE_TIMEOUT_SECONDS;
    }
    int seconds;
    try {
      seconds = Integer.parseInt(value);
    } catch (NumberFormatException error) {
      throw new IllegalArgumentException(
          "--case-timeout-seconds must be an integer number of seconds.");
    }
    if (seconds < 1 || seconds > MAXIMUM_CASE_TIMEOUT_SECONDS) {
      throw new IllegalArgumentException(
          "--case-timeout-seconds must be between 1 and " + MAXIMUM_CASE_TIMEOUT_SECONDS + ".");
    }
    return seconds;
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
      case "--case-timeout-seconds":
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
