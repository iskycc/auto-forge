package com.autoforge.adapters.cotest;

import java.io.PrintStream;
import java.lang.reflect.Method;
import java.util.Collections;
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
        xmlTestClass.getMethod("setClasses", List.class),
        xmlTest,
        Collections.singletonList(xmlClass));
    ReflectionSupport.invoke(
        testNgClass.getMethod("setXmlSuites", List.class),
        testNg,
        Collections.singletonList(xmlSuite));
    ReflectionSupport.invoke(
        testNgClass.getMethod("setOutputDirectory", String.class),
        testNg,
        request.outputDirectory().toString());

    Object listener = createListener(loader);
    Class<?> listenerInterface = Class.forName("org.testng.ITestNGListener", true, loader);
    ReflectionSupport.invoke(
        testNgClass.getMethod("addListener", listenerInterface), testNg, listener);

    new CotestRuntimeConfigurer(output)
        .configure(loader, testClass, request.environmentAddress(), request.caseId());
    ReflectionSupport.invoke(testNgClass.getMethod("run"), testNg);

    TestNgResultSummary summary = new TestNgResultReporter(output).report(loader, listener);
    Method getStatus = testNgClass.getMethod("getStatus");
    int testNgStatus = (Integer) ReflectionSupport.invoke(getStatus, testNg);
    output.println(System.lineSeparator() + "TestNG exit status: " + testNgStatus);
    // TestNG 状态包含跳过位；任何失败、跳过、配置失败或未执行测试都不能报告成功。
    boolean unsuccessful = summary.failedCount() > 0 || summary.skippedCount() > 0
        || summary.configurationFailureCount() > 0 || summary.passedCount() == 0;
    return new TestNgExecutionOutcome(unsuccessful ? 1 : 0);
  }

  private static Object createListener(ClassLoader loader) throws ReflectiveOperationException {
    Class<?> listenerClass = Class.forName("org.testng.TestListenerAdapter", true, loader);
    return listenerClass.getDeclaredConstructor().newInstance();
  }
}
