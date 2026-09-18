package com.autoforge.javacases;

import cotest.auto.dataproviders.MM2DataProvider;
import com.huawei.cotest.util.ProjectFileUtil;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.testng.annotations.Test;

public final class JavaCasesDdtFixture {
  private static final String EXPECTED_MARKER = "CASE_ID_FETCHED_FROM_PUBLIC_API";

  @Test
  public void fetchesDdtDataUsingTheInjectedCaseId() throws Exception {
    String caseId = MM2DataProvider.getClassDataProvider(getClass().getName());
    if (caseId == null || !caseId.startsWith("JAVA-CASES-DDT")) {
      throw new AssertionError("Raw DDT CaseID was not injected for " + getClass().getName());
    }

    // The test itself owns API configuration and fetching. Runner/Adapter only pass CaseID.
    URL endpoint = new URL(ProjectFileUtil.getEnvIP() + "/case?caseId="
        + URLEncoder.encode(caseId, StandardCharsets.UTF_8.name()));
    HttpURLConnection connection = (HttpURLConnection) endpoint.openConnection();
    connection.setConnectTimeout(10_000);
    connection.setReadTimeout(10_000);
    try {
      if (connection.getResponseCode() != 200) {
        throw new AssertionError("DDT public API returned " + connection.getResponseCode());
      }
      try (InputStream body = connection.getInputStream()) {
        String caseData = new String(body.readNBytes(65_536), StandardCharsets.UTF_8);
        if (!caseData.contains("\"verificationMarker\":\"" + EXPECTED_MARKER + "\"")) {
          throw new AssertionError("DDT public API did not return the expected marker");
        }
        if (!caseData.contains("\"CaseID\":\"" + caseId + "\"")
            || !caseData.contains("\"srNum\":\"EXECUTION\"")) {
          throw new AssertionError("DDT public API did not return the requested CaseID and SR");
        }
      }
    } finally {
      connection.disconnect();
    }

    System.out.println("JAVA_CASES_DDT_API_OK:" + EXPECTED_MARKER);
  }
}
