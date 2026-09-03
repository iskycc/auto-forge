package com.autoforge.adapters.cotest;

import java.io.PrintStream;
import java.lang.reflect.Method;
import java.nio.file.Path;

final class CotestRuntimeConfigurer {
  private static final String PROJECT_FILE_UTILITY = "com.huawei.cotest.util.ProjectFileUtil";
  private static final String DATA_PROVIDER = "cotest.auto.dataproviders.MM2DataProvider";

  private final PrintStream output;

  CotestRuntimeConfigurer(PrintStream output) {
    this.output = output;
  }

  void configure(
      ClassLoader loader, Class<?> testClass, String environmentAddress, Path classDataFile)
      throws ReflectiveOperationException {
    if (!TextValues.isBlank(environmentAddress)) {
      Class<?> projectFileUtility = Class.forName(PROJECT_FILE_UTILITY, true, loader);
      Method setEnvironmentAddress = projectFileUtility.getMethod("setEnvIP", String.class);
      ReflectionSupport.invoke(setEnvironmentAddress, null, environmentAddress);
      output.println("Configured CoTest environment address: " + environmentAddress);
    }

    if (classDataFile == null) {
      return;
    }
    Class<?> dataProvider = Class.forName(DATA_PROVIDER, true, loader);
    Method setClassDataProvider =
        dataProvider.getMethod("setClassDataProvider", String.class, String.class);
    ReflectionSupport.invoke(
        setClassDataProvider, null, testClass.getName(), classDataFile.toString());
    output.println(
        "Configured class data provider for "
            + testClass.getName()
            + ": "
            + classDataFile);
  }
}
