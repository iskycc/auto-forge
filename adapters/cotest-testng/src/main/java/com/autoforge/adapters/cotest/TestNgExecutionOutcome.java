package com.autoforge.adapters.cotest;

final class TestNgExecutionOutcome {
  private final int exitCode;
  private final String firstFailure;

  TestNgExecutionOutcome(int exitCode, String firstFailure) {
    this.exitCode = exitCode;
    this.firstFailure = firstFailure;
  }

  int exitCode() {
    return exitCode;
  }

  String firstFailure() {
    return firstFailure;
  }
}
