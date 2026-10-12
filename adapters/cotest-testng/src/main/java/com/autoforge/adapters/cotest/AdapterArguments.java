package com.autoforge.adapters.cotest;

import java.net.URI;
import java.net.URISyntaxException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

final class AdapterArguments {
  static final int DEFAULT_CASE_TIMEOUT_SECONDS = 600;
  static final int MAXIMUM_CASE_TIMEOUT_SECONDS = 86_400;
  private static final int MAXIMUM_CASE_ID_CHARACTERS = 512;
  private static final int MAXIMUM_ENCODED_CASE_ID_LENGTH =
      ((MAXIMUM_CASE_ID_CHARACTERS * 4 + 2) / 3) * 4;

  static final String USAGE =
      "Usage: java -jar cotest-testng-adapter.jar "
          + "--jars DIR --class CLASS [--environment-address VALUE] "
          + "[--case-id CASE_ID | --case-id-base64 UTF8_BASE64] "
          + "[--ddt-insight-url URL] [--config FILE] [--suite-name NAME] "
          + "[--test-name NAME] [--output DIR] [--case-timeout-seconds SECONDS]";

  private final Path jarDirectory;
  private final String className;
  private final String environmentAddress;
  private final String caseId;
  private final String ddtInsightUrl;
  private final Path configurationFile;
  private final String suiteName;
  private final String testName;
  private final Path outputDirectory;
  private final int caseTimeoutSeconds;

  private AdapterArguments(Map<String, String> options) {
    jarDirectory = Paths.get(required(options, "--jars"));
    className = required(options, "--class");
    environmentAddress = options.getOrDefault("--environment-address", "");
    caseId = validatedCaseId(options);
    ddtInsightUrl = validatedDdtInsightUrl(options.get("--ddt-insight-url"));
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

  String caseId() {
    return caseId;
  }

  String ddtInsightUrl() {
    return ddtInsightUrl;
  }

  private static String validatedCaseId(Map<String, String> options) {
    String caseId = options.get("--case-id");
    String encodedCaseId = options.get("--case-id-base64");
    if (caseId != null && encodedCaseId != null) {
      throw new IllegalArgumentException("--case-id and --case-id-base64 cannot be used together.");
    }
    if (encodedCaseId != null) {
      if (encodedCaseId.length() > MAXIMUM_ENCODED_CASE_ID_LENGTH) {
        throw new IllegalArgumentException("--case-id-base64 exceeds the encoded CaseID limit.");
      }
      try {
        byte[] utf8 = Base64.getDecoder().decode(encodedCaseId);
        // The JVM has already decoded argv using the native locale. Only ASCII crosses
        // that boundary; reject damaged UTF-8 instead of silently replacing characters.
        caseId =
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(utf8))
                .toString();
      } catch (IllegalArgumentException | CharacterCodingException invalid) {
        throw new IllegalArgumentException(
            "--case-id-base64 must contain valid UTF-8 Base64.", invalid);
      }
    }
    if (caseId == null) return null;
    if (TextValues.isBlank(caseId)
        || caseId.length() > MAXIMUM_CASE_ID_CHARACTERS
        || caseId.indexOf('\0') >= 0) {
      throw new IllegalArgumentException(
          "DDT CaseID must be nonblank, contain no NUL and not exceed 512 characters.");
    }
    return caseId;
  }

  private static String validatedDdtInsightUrl(String value) {
    if (value == null) return null;
    try {
      URI uri = new URI(value);
      if (value.length() <= 8192
          && ("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()))
          && uri.getHost() != null
          && uri.getUserInfo() == null
          && uri.getRawQuery() == null
          && uri.getRawFragment() == null
          && uri.getPath().endsWith("/case")) {
        return value;
      }
    } catch (URISyntaxException invalid) {
      throw new IllegalArgumentException(
          "--ddt-insight-url must be a valid DDT case API URL.", invalid);
    }
    throw new IllegalArgumentException(
        "--ddt-insight-url must be HTTP(S), end with /case "
            + "and contain no credentials, query or fragment.");
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
      case "--case-id":
      case "--case-id-base64":
      case "--ddt-insight-url":
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
