package com.autoforge.adapters.cotest;

import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

final class AdapterExecutionRequest {
  private final List<URL> jarUrls;
  private final String className;
  private final SuiteConfiguration suiteConfiguration;
  private final String environmentAddress;
  private final Path classDataFile;
  private final Path outputDirectory;

  AdapterExecutionRequest(
      List<URL> jarUrls,
      String className,
      SuiteConfiguration suiteConfiguration,
      String environmentAddress,
      Path classDataFile,
      Path outputDirectory) {
    this.jarUrls = List.copyOf(jarUrls);
    this.className = className;
    this.suiteConfiguration = suiteConfiguration;
    this.environmentAddress = environmentAddress;
    this.classDataFile = normalizeClassDataFile(classDataFile);
    this.outputDirectory = outputDirectory.toAbsolutePath().normalize();
  }

  List<URL> jarUrls() {
    return jarUrls;
  }

  String className() {
    return className;
  }

  SuiteConfiguration suiteConfiguration() {
    return suiteConfiguration;
  }

  String environmentAddress() {
    return environmentAddress;
  }

  Path classDataFile() {
    return classDataFile;
  }

  Path outputDirectory() {
    return outputDirectory;
  }

  private static Path normalizeClassDataFile(Path classDataFile) {
    if (classDataFile == null) {
      return null;
    }
    Path normalized = classDataFile.toAbsolutePath().normalize();
    if (!Files.isRegularFile(normalized)) {
      throw new IllegalArgumentException("Class data file does not exist: " + normalized);
    }
    return normalized;
  }
}
