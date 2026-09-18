package com.autoforge.adapters.cotest;

import java.net.URL;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class AdapterExecutionRequest {
  private final List<URL> jarUrls;
  private final String className;
  private final SuiteConfiguration suiteConfiguration;
  private final String environmentAddress;
  private final String caseId;
  private final Path outputDirectory;

  AdapterExecutionRequest(
      List<URL> jarUrls,
      String className,
      SuiteConfiguration suiteConfiguration,
      String environmentAddress,
      String caseId,
      Path outputDirectory) {
    this.jarUrls = Collections.unmodifiableList(new ArrayList<URL>(jarUrls));
    this.className = className;
    this.suiteConfiguration = suiteConfiguration;
    this.environmentAddress = environmentAddress;
    this.caseId = caseId;
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

  String caseId() {
    return caseId;
  }

  Path outputDirectory() {
    return outputDirectory;
  }
}
