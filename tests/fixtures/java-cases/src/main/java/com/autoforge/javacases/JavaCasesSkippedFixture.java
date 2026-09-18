package com.autoforge.javacases;

import org.testng.SkipException;
import org.testng.annotations.Test;

public final class JavaCasesSkippedFixture {
  @Test
  public void skipsWithoutAnyPassingTests() {
    throw new SkipException("JAVA_CASES_SKIPPED_MUST_FAIL");
  }
}
