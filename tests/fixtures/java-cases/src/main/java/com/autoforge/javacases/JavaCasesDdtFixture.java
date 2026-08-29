package com.autoforge.javacases;

import cotest.auto.dataproviders.MM2DataProvider;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.testng.annotations.Test;

public final class JavaCasesDdtFixture {
  private static final String EXPECTED_MARKER = "CLASS_DATA_REACHED_ADAPTER";

  @Test
  public void receivesDdtClassDataFromRunner() throws Exception {
    String classDataFile = MM2DataProvider.getClassDataProvider(getClass().getName());
    if (classDataFile == null || classDataFile.isBlank()) {
      throw new AssertionError("DDT classDataFile was not injected for " + getClass().getName());
    }

    String classData = Files.readString(Path.of(classDataFile), StandardCharsets.UTF_8);
    if (!classData.contains("\"verificationMarker\":\"" + EXPECTED_MARKER + "\"")) {
      throw new AssertionError("DDT classDataFile does not contain the expected marker");
    }
    if (!classData.contains("\"CaseID\":") || !classData.contains("\"srNum\":\"EXECUTION\"")) {
      throw new AssertionError("DDT classDataFile does not contain its CaseID and SR identity");
    }

    System.out.println("JAVA_CASES_DDT_CLASS_DATA_OK:" + EXPECTED_MARKER);
  }
}
