package com.autoforge.adapters.cotest;

import java.io.PrintStream;
import java.lang.reflect.Method;

final class CotestRuntimeConfigurer {
  private static final String PROJECT_FILE_UTILITY = "com.huawei.cotest.util.ProjectFileUtil";
  private static final String DATA_PROVIDER = "cotest.auto.dataproviders.MM2DataProvider";

  private final PrintStream output;

  CotestRuntimeConfigurer(PrintStream output) {
    this.output = output;
  }

  void configure(
      ClassLoader loader,
      Class<?> testClass,
      String environmentAddress,
      String caseId,
      String ddtInsightUrl)
      throws ReflectiveOperationException {
    if (!TextValues.isBlank(environmentAddress)) {
      Class<?> projectFileUtility = Class.forName(PROJECT_FILE_UTILITY, true, loader);
      Method setEnvironmentAddress = projectFileUtility.getMethod("setEnvIP", String.class);
      ReflectionSupport.invoke(setEnvironmentAddress, null, environmentAddress);
      output.println("Configured CoTest environment address: " + environmentAddress);
    }

    if (caseId == null && ddtInsightUrl == null) return;
    Class<?> dataProvider;
    try {
      dataProvider = Class.forName(DATA_PROVIDER, true, loader);
    } catch (ClassNotFoundException missing) {
      // Ordinary TestNG classes do not require CoTest. DDT executions must fail explicitly.
      if (caseId != null) throw missing;
      output.println("DDT API configuration not applicable: MM2DataProvider is absent.");
      return;
    }
    if (ddtInsightUrl != null) {
      Method setDdtInsightUrl;
      try {
        setDdtInsightUrl = dataProvider.getMethod("setDdtInsightUrl", String.class);
      } catch (NoSuchMethodException missing) {
        throw new IllegalStateException(
            "MM2DataProvider.setDdtInsightUrl(String) is missing; "
                + "update the project's complete dependency JAR bundle.",
            missing);
      }
      ReflectionSupport.invoke(setDdtInsightUrl, null, ddtInsightUrl);
      output.println("Configured DDT API URL: " + ddtInsightUrl);
    }
    if (caseId != null) {
      Method setClassDataProvider =
          dataProvider.getMethod("setClassDataProvider", String.class, String.class);
      ReflectionSupport.invoke(setClassDataProvider, null, testClass.getName(), caseId);
      output.println("Configured DDT CaseID for " + testClass.getName() + ": " + caseId);
    }
  }
}
