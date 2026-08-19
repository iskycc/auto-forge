package com.autoforge.adapters.cotest;

final class TestNgExecutionOutcome {
  private final int exitCode;

  TestNgExecutionOutcome(int exitCode) {
    this.exitCode = exitCode;
  }

  int exitCode() {
    return exitCode;
  }
}
