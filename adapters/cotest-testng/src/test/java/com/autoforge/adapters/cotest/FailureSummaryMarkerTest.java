package com.autoforge.adapters.cotest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.jupiter.api.Test;

class FailureSummaryMarkerTest {
  @Test
  void encodesMultilineChineseFailureAsOneAsciiLineWithoutLosingContent() {
    String summary =
        "java.lang.AssertionError: 中文断言失败\n第二行详情：" + "预期与实际不一致；".repeat(80);

    String marker = FailureSummaryMarker.encode(summary);

    assertTrue(marker.startsWith(FailureSummaryMarker.PREFIX + "["));
    assertTrue(marker.endsWith("]"));
    assertFalse(marker.contains("\n"));
    String payload =
        marker.substring(
            (FailureSummaryMarker.PREFIX + "[").length(), marker.length() - 1);
    assertEquals(
        summary,
        new String(Base64.getDecoder().decode(payload), StandardCharsets.UTF_8));
  }
}
