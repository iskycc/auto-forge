package com.autoforge.adapters.cotest;

import java.io.PrintStream;
import java.lang.reflect.Method;
import java.util.List;

final class ReflectiveTestNgRunner {
  private final PrintStream output;

  ReflectiveTestNgRunner(PrintStream output) {
    this.output = output;
  }

  TestNgExecutionOutcome run(
      ClassLoader loader, Class<?> testClass, AdapterExecutionRequest request)
      throws ReflectiveOperationException {
    Class<?> testNgClass = Class.forName("org.testng.TestNG", true, loader);
    Class<?> xmlSuiteClass = Class.forName("org.testng.xml.XmlSuite", true, loader);
    Class<?> xmlTestClass = Class.forName("org.testng.xml.XmlTest", true, loader);
    Class<?> xmlClassClass = Class.forName("org.testng.xml.XmlClass", true, loader);

    Object testNg = testNgClass.getDeclaredConstructor().newInstance();
    Object xmlSuite = xmlSuiteClass.getDeclaredConstructor().newInstance();
    ReflectionSupport.invoke(
        xmlSuiteClass.getMethod("setName", String.class),
        xmlSuite,
        request.suiteConfiguration().suiteName());

    Object xmlTest = xmlTestClass.getDeclaredConstructor(xmlSuiteClass).newInstance(xmlSuite);
    ReflectionSupport.invoke(
        xmlTestClass.getMethod("setName", String.class),
        xmlTest,
        request.suiteConfiguration().testName());

    Object xmlClass = xmlClassClass.getConstructor(Class.class).newInstance(testClass);
    ReflectionSupport.invoke(
        xmlTestClass.getMethod("setClasses", List.class), xmlTest, List.of(xmlClass));
    ReflectionSupport.invoke(
        testNgClass.getMethod("setXmlSuites", List.class), testNg, List.of(xmlSuite));
    ReflectionSupport.invoke(
        testNgClass.getMethod("setOutputDirectory", String.class),
        testNg,
        request.outputDirectory().toString());

    Object listener = createListener(loader);
    Class<?> listenerInterface = Class.forName("org.testng.ITestNGListener", true, loader);
    ReflectionSupport.invoke(
        testNgClass.getMethod("addListener", listenerInterface), testNg, listener);

    new CotestRuntimeConfigurer(output)
        .configure(loader, testClass, request.environmentAddress(), request.classDataFile());
    ReflectionSupport.invoke(testNgClass.getMethod("run"), testNg);

    TestNgResultSummary summary = new TestNgResultReporter(output).report(loader, listener);
    Method getStatus = testNgClass.getMethod("getStatus");
    int testNgStatus = (Integer) ReflectionSupport.invoke(getStatus, testNg);
    output.println(System.lineSeparator() + "TestNG exit status: " + testNgStatus);
    // TestNG 的 getStatus() 是位图（含跳过位）：有用例被跳过时即使全部通过也非零。
    // 进程退出码只表达是否存在真实失败，跳过-only 的执行由控制面根据 testng-results.xml
    // 映射为成功（全部跳过 / 通过含跳过）。
    boolean hasFailures = summary.failedCount() + summary.configurationFailureCount() > 0;
    return new TestNgExecutionOutcome(hasFailures ? 1 : 0);
  }

  private static Object createListener(ClassLoader loader) throws ReflectiveOperationException {
    Class<?> listenerClass = Class.forName("org.testng.TestListenerAdapter", true, loader);
    return listenerClass.getDeclaredConstructor().newInstance();
  }
}
