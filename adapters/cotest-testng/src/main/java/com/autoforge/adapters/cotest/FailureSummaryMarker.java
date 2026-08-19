package com.autoforge.adapters.cotest;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

/** Stable machine-readable boundary between the adapter log and the control plane. */
final class FailureSummaryMarker {
  static final String PREFIX = "TestCase Run Failed Stack Base64: ";

  private FailureSummaryMarker() {}

  static String encode(String summary) {
    String payload =
        Base64.getEncoder().encodeToString(summary.getBytes(StandardCharsets.UTF_8));
    return PREFIX + "[" + payload + "]";
  }
}
