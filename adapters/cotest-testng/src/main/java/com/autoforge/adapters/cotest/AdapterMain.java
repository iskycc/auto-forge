package com.autoforge.adapters.cotest;

import java.io.PrintStream;
import java.net.URL;
import java.util.List;

public final class AdapterMain {
  private AdapterMain() {}

  public static void main(String[] arguments) {
    System.exit(run(arguments, System.out, System.err));
  }

  static int run(String[] arguments, PrintStream output, PrintStream errorOutput) {
    try {
      AdapterArguments parsed = AdapterArguments.parse(arguments);
      List<URL> jarUrls = new JarDirectoryScanner().scan(parsed.jarDirectory());
      SuiteConfiguration suiteConfiguration =
          new SuiteConfigurationLoader()
              .load(parsed.configurationFile(), parsed.suiteName(), parsed.testName());
      AdapterExecutionRequest request =
          new AdapterExecutionRequest(
              jarUrls,
              parsed.className(),
              suiteConfiguration,
              parsed.environmentAddress(),
              parsed.classDataFile(),
              parsed.outputDirectory());
      return new CotestTestNgExecutor(output, errorOutput).execute(request);
    } catch (IllegalArgumentException error) {
      errorOutput.println(error.getMessage());
      return 2;
    }
  }
}
