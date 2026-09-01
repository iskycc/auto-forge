import { describe, expect, it } from "vitest";

import { presentAnalyticsFailure } from "./analytics-failure-presentation";

describe("presentAnalyticsFailure", () => {
  it.each(["TESTNG_ASSERTIONS_FAILED", "TESTNG_CONFIGURATION_FAILED", "TEST_ASSERTION_FAILED"])(
    "hides the internal code for a normal TestNG failure: %s",
    (resultCode) => {
      expect(
        presentAnalyticsFailure({
          description: "java.lang.AssertionError: expected 200 but was 500",
          resultCode,
        }),
      ).toEqual({
        detail: "java.lang.AssertionError: expected 200 but was 500",
        isExecutionFailure: false,
      });
    },
  );

  it("keeps both the code and readable information for an abnormal execution failure", () => {
    expect(
      presentAnalyticsFailure({
        description: "Execution exceeded its configured timeout.",
        resultCode: "EXECUTION_TIMEOUT",
      }),
    ).toEqual({
      detail: "Execution exceeded its configured timeout.",
      errorCode: "EXECUTION_TIMEOUT",
      isExecutionFailure: true,
    });
  });
});
