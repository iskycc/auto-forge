import { describe, expect, it } from "vitest";
import {
  consumeSuiteExecutionEnvironment,
  executionEnvironmentDraftKey,
  readSuiteExecutionEnvironment,
  setSuiteExecutionEnvironment,
} from "./suite-execution-environment";

describe("next manual task execution environment", () => {
  it("isolates users and tasks and consumes only the accepted request", () => {
    const key = executionEnvironmentDraftKey("operator", "locked-task");
    const anotherTask = executionEnvironmentDraftKey("operator", "another-task");
    const anotherUser = executionEnvironmentDraftKey("owner", "locked-task");
    const input = ["10.0.0.99", "2001:db8::99"];
    setSuiteExecutionEnvironment(key, input);
    input[0] = "10.0.0.100";
    const submitted = readSuiteExecutionEnvironment(key);
    expect(submitted).toEqual(["10.0.0.99", "2001:db8::99"]);
    expect(readSuiteExecutionEnvironment(anotherTask)).toBeUndefined();
    expect(readSuiteExecutionEnvironment(anotherUser)).toBeUndefined();
    // Cancel and failure never acknowledge the draft.
    expect(readSuiteExecutionEnvironment(key)).toBe(submitted);
    consumeSuiteExecutionEnvironment(key, ["10.0.0.99", "2001:db8::99"]);
    expect(readSuiteExecutionEnvironment(key)).toBe(submitted);
    setSuiteExecutionEnvironment(key, ["10.0.0.101"]);
    consumeSuiteExecutionEnvironment(key, submitted);
    expect(readSuiteExecutionEnvironment(key)).toEqual(["10.0.0.101"]);
    consumeSuiteExecutionEnvironment(key, readSuiteExecutionEnvironment(key));
    expect(readSuiteExecutionEnvironment(key)).toBeUndefined();
  });

  it("bounds the number of edited tasks and each address list", () => {
    const keys = Array.from({ length: 129 }, (_, index) =>
      executionEnvironmentDraftKey("capacity-user", String(index)),
    );
    for (const key of keys) setSuiteExecutionEnvironment(key, ["10.0.0.1"]);
    expect(readSuiteExecutionEnvironment(keys[0]!)).toBeUndefined();
    expect(readSuiteExecutionEnvironment(keys.at(-1)!)).toEqual(["10.0.0.1"]);
    expect(() => setSuiteExecutionEnvironment(keys[1]!, Array(129).fill("10.0.0.1"))).toThrow(
      "最多 128",
    );
    for (const key of keys) setSuiteExecutionEnvironment(key, undefined);
  });
});
