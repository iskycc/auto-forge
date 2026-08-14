package com.autoforge.adapters.cotest;

import java.io.PrintStream;
import java.lang.reflect.Method;
import java.util.List;

final class TestNgResultReporter {
  private final PrintStream output;

  TestNgResultReporter(PrintStream output) {
    this.output = output;
  }

  String report(ClassLoader loader, Object listener) throws ReflectiveOperationException {
    Class<?> listenerClass = Class.forName("org.testng.TestListenerAdapter", true, loader);
    Class<?> resultClass = Class.forName("org.testng.ITestResult", true, loader);
    Class<?> testClassInterface = Class.forName("org.testng.IClass", true, loader);
    Class<?> testMethodInterface = Class.forName("org.testng.ITestNGMethod", true, loader);

    List<?> failedTests = results(listenerClass, listener, "getFailedTests");
    List<?> skippedTests = results(listenerClass, listener, "getSkippedTests");
    List<?> configurationFailures =
        results(listenerClass, listener, "getConfigurationFailures");
    List<?> passedTests = results(listenerClass, listener, "getPassedTests");

    output.println(System.lineSeparator() + "========== Test Results Summary ==========");
    output.println("Passed: " + passedTests.size());
    output.println("Failed: " + failedTests.size());
    output.println("Skipped: " + skippedTests.size());
    output.println("Configuration Failures: " + configurationFailures.size());

    String firstFailure =
        printResults(
            failedTests,
            resultClass,
            testClassInterface,
            testMethodInterface,
            "FAILED",
            true);
    printResults(
        skippedTests,
        resultClass,
        testClassInterface,
        testMethodInterface,
        "SKIPPED",
        false);
    String firstConfigurationFailure =
        printResults(
            configurationFailures,
            resultClass,
            testClassInterface,
            testMethodInterface,
            "CONFIGURATION FAILURE",
            true);
    return firstFailure != null ? firstFailure : firstConfigurationFailure;
  }

  @SuppressWarnings("unchecked")
  private static List<?> results(Class<?> listenerClass, Object listener, String methodName)
      throws ReflectiveOperationException {
    Object value = ReflectionSupport.invoke(listenerClass.getMethod(methodName), listener);
    if (!(value instanceof List<?>)) {
      throw new ReflectiveOperationException(
          "TestNG listener method did not return a List: " + methodName);
    }
    return (List<?>) value;
  }

  private String printResults(
      List<?> results,
      Class<?> resultClass,
      Class<?> testClassInterface,
      Class<?> testMethodInterface,
      String status,
      boolean captureFailure)
      throws ReflectiveOperationException {
    if (results.isEmpty()) {
      return null;
    }
    output.println(
        System.lineSeparator() + "========== " + status + " Tests (" + results.size() + ") ==========");
    String firstFailure = null;
    for (Object result : results) {
      ResultDetails details =
          details(result, resultClass, testClassInterface, testMethodInterface);
      output.println(
          System.lineSeparator()
              + "---------- "
              + status
              + ": "
              + details.className
              + "."
              + details.methodName
              + " ----------");
      if (details.throwable != null) {
        output.println("Exception Type: " + details.throwable.getClass().getName());
        output.println("Message: " + String.valueOf(details.throwable.getMessage()));
        output.println(System.lineSeparator() + "Stack Trace:");
        details.throwable.printStackTrace(output);
        if (captureFailure && firstFailure == null) {
          firstFailure = failureSummary(details.throwable);
        }
      } else if (captureFailure && firstFailure == null) {
        firstFailure = details.className + "." + details.methodName + " failed without an exception.";
      }
      printParameters(details.parameters);
    }
    return firstFailure;
  }

  private static ResultDetails details(
      Object result,
      Class<?> resultClass,
      Class<?> testClassInterface,
      Class<?> testMethodInterface)
      throws ReflectiveOperationException {
    Object testClass =
        ReflectionSupport.invoke(resultClass.getMethod("getTestClass"), result);
    String className =
        (String) ReflectionSupport.invoke(testClassInterface.getMethod("getName"), testClass);
    Object testMethod = ReflectionSupport.invoke(resultClass.getMethod("getMethod"), result);
    String methodName =
        (String)
            ReflectionSupport.invoke(
                testMethodInterface.getMethod("getMethodName"), testMethod);
    Throwable throwable =
        (Throwable) ReflectionSupport.invoke(resultClass.getMethod("getThrowable"), result);
    Object[] parameters =
        (Object[]) ReflectionSupport.invoke(resultClass.getMethod("getParameters"), result);
    return new ResultDetails(className, methodName, throwable, parameters);
  }

  private void printParameters(Object[] parameters) {
    if (parameters == null || parameters.length == 0) {
      return;
    }
    output.println("Parameters:");
    for (int index = 0; index < parameters.length; index++) {
      output.println("  [" + index + "] " + String.valueOf(parameters[index]));
    }
  }

  private static String failureSummary(Throwable failure) {
    String message = failure.getMessage();
    return message == null || message.isBlank() ? failure.getClass().getName() : message;
  }

  private static final class ResultDetails {
    private final String className;
    private final String methodName;
    private final Throwable throwable;
    private final Object[] parameters;

    private ResultDetails(
        String className, String methodName, Throwable throwable, Object[] parameters) {
      this.className = className;
      this.methodName = methodName;
      this.throwable = throwable;
      this.parameters = parameters;
    }
  }
}
