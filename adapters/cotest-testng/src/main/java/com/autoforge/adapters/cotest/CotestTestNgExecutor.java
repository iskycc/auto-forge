package com.autoforge.adapters.cotest;

import java.io.IOException;
import java.io.PrintStream;
import java.nio.file.Files;

final class CotestTestNgExecutor {
  private final PrintStream output;
  private final PrintStream errorOutput;

  CotestTestNgExecutor(PrintStream output, PrintStream errorOutput) {
    this.output = output;
    this.errorOutput = errorOutput;
  }

  int execute(AdapterExecutionRequest request) {
    Thread executionThread = Thread.currentThread();
    ClassLoader originalContextLoader = executionThread.getContextClassLoader();
    String firstFailure = null;
    try (IsolatedJarClassLoader loader =
        new IsolatedJarClassLoader(request.jarUrls(), AdapterMain.class.getClassLoader())) {
      Files.createDirectories(request.outputDirectory());
      executionThread.setContextClassLoader(loader);
      try {
        Class<?> testClass = Class.forName(request.className(), true, loader);
        TestNgExecutionOutcome outcome =
            new ReflectiveTestNgRunner(output).run(loader, testClass, request);
        firstFailure = outcome.firstFailure();
        return outcome.exitCode();
      } finally {
        executionThread.setContextClassLoader(originalContextLoader);
      }
    } catch (ReflectiveOperationException | IOException | LinkageError | RuntimeException failure) {
      Throwable cause = ReflectionSupport.rootCause(failure);
      firstFailure = failureSummary(cause);
      errorOutput.println("Exception during adapter test execution:");
      cause.printStackTrace(errorOutput);
      return 1;
    } finally {
      if (firstFailure != null) {
        output.println(
            System.lineSeparator() + "TestCase Run Failed Stack: [" + firstFailure + "]");
      }
    }
  }

  private static String failureSummary(Throwable failure) {
    // Parsing contract with the control plane (control-executions.ts): the marker content must
    // stay on a single line and equal the first line after "Stack Trace:" in the report.
    return failure.toString();
  }
}
