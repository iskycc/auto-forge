package com.autoforge.javacases;

import org.testng.Assert;
import org.testng.annotations.Test;

/** java-cases 模块的失败验收用例：先产生真实输出，再断言失败。 */
public final class JavaCasesFailureFixture {
  @Test(groups = {"java-cases"}, description = "java-cases 失败重试链路验收")
  public void failsAfterRealProcessOutput() {
    System.out.println("INFO java-cases failure fixture started");
    System.out.println("DEBUG emitting pre-assertion diagnostics");
    System.out.println("ERROR deliberate assertion failure to exercise the retry chain");
    System.out.println("JAVA_CASES_FAILURE_OUTPUT_BEFORE_ASSERTION");
    Assert.assertTrue(
        false,
        "订单创建失败 OrderId 不能为空，中文断言必须保持 UTF-8 / mixed English message");
  }
}
