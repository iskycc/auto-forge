package com.autoforge.adapters.cotest;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

public final class AdapterMain {
  // 进程退出码约定：0 成功；1 用例失败或 adapter 执行异常；2 参数错误；3 用例执行超时。
  static final int CASE_TIMEOUT_EXIT_CODE = 3;

  private AdapterMain() {}

  public static void main(String[] arguments) {
    // Do not rely on the host locale or an older JDK's console defaults. User tests write to
    // System.out/System.err directly, so install UTF-8 streams before loading any test class.
    PrintStream output = utf8PrintStream(new FileOutputStream(FileDescriptor.out));
    PrintStream errorOutput = utf8PrintStream(new FileOutputStream(FileDescriptor.err));
    System.setOut(output);
    System.setErr(errorOutput);
    System.exit(run(arguments, output, errorOutput));
  }

  static PrintStream utf8PrintStream(OutputStream destination) {
    return new PrintStream(destination, true, StandardCharsets.UTF_8);
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
      return executeWithCaseTimeout(request, parsed.caseTimeoutSeconds(), output, errorOutput);
    } catch (IllegalArgumentException error) {
      errorOutput.println(error.getMessage());
      return 2;
    }
  }

  // 用例执行超时由 adapter 自己管理：TestNG 执行放在守护工作线程中，主线程有限等待；
  // 超时后输出机器可读标记并以退出码 3 结束（main 的 System.exit 会终止残留线程）。
  private static int executeWithCaseTimeout(
      AdapterExecutionRequest request,
      int timeoutSeconds,
      PrintStream output,
      PrintStream errorOutput) {
    ExecutorService executor =
        Executors.newSingleThreadExecutor(
            runnable -> {
              Thread worker = new Thread(runnable, "adapter-case-execution");
              worker.setDaemon(true);
              return worker;
            });
    try {
      Future<Integer> result =
          executor.submit(() -> new CotestTestNgExecutor(output, errorOutput).execute(request));
      try {
        return result.get(timeoutSeconds, TimeUnit.SECONDS);
      } catch (TimeoutException timeout) {
        result.cancel(true);
        output.println(
            System.lineSeparator()
                + "TestCase Execution Timeout: case execution exceeded "
                + timeoutSeconds
                + " second(s) and was forcibly terminated by the adapter.");
        return CASE_TIMEOUT_EXIT_CODE;
      } catch (ExecutionException failure) {
        Throwable cause = failure.getCause() != null ? failure.getCause() : failure;
        errorOutput.println("Exception during adapter test execution:");
        cause.printStackTrace(errorOutput);
        return 1;
      } catch (InterruptedException interrupt) {
        Thread.currentThread().interrupt();
        errorOutput.println("Adapter test execution was interrupted before completion.");
        return 1;
      }
    } finally {
      executor.shutdownNow();
    }
  }
}
